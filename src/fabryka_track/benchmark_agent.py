"""Always-on GPU pull worker. One isolated child per lease, bounded lifetime."""
import json
import os
from pathlib import Path
import subprocess
import sys
import time
import httpx


def gpu_ready():
    """Opt-in idle check before claiming work; an unreadable GPU is not idle."""
    if os.environ.get('TRACK_BENCHMARK_REQUIRE_IDLE')!='1':return True
    try:
        output=subprocess.check_output(['nvidia-smi','-i',os.environ.get('TRACK_BENCHMARK_GPU_INDEX','0'),
            '--query-gpu=utilization.gpu,memory.free','--format=csv,noheader,nounits'],text=True,timeout=10)
        utilization,free=[int(value.strip()) for value in output.strip().split(',')]
        return utilization<=15 and free>=int(os.environ.get('TRACK_BENCHMARK_MIN_FREE_MB','10000'))
    except (OSError,ValueError,subprocess.SubprocessError):return False


def runner_status(root,state,**details):
    tmp=root/'status.tmp'
    tmp.write_text(json.dumps({'state':state,'updated_at':time.time(),**details}))
    tmp.replace(root/'status.json')

def child(spec_path,progress_path):
    from .benchmark_worker import run
    state={}
    def report(**values):
        state.update(values)
        tmp=progress_path.with_suffix('.tmp');tmp.write_text(json.dumps(state,default=str));tmp.replace(progress_path)
    spec=json.loads(spec_path.read_text())
    try:run(spec['id'],job=spec,reporter=report)
    except Exception as exc:
        report(status='failed',error='Evaluation failed: '+type(exc).__name__)
        raise


def main():
    base=os.environ.get('TRACK_URL','https://track.fabryka.ai').rstrip('/')+'/api/benchmark-runner'
    root=Path(os.environ.get('TRACK_BENCHMARK_WORKDIR','./benchmark-work'));root.mkdir(parents=True,exist_ok=True)
    with httpx.Client(headers={'Authorization':'Bearer '+os.environ['TRACK_RUNNER_TOKEN']},timeout=30) as client:
        idle_checks=0
        while True:
            try:
                if not gpu_ready():
                    idle_checks=0;runner_status(root,'waiting_for_idle_gpu');time.sleep(10);continue
                if os.environ.get('TRACK_BENCHMARK_REQUIRE_IDLE')=='1':
                    idle_checks+=1
                    if idle_checks<3:
                        runner_status(root,'checking_gpu_idle');time.sleep(10);continue
                response=client.post(base+'/claim');response.raise_for_status();job=response.json()['job']
                if not job:runner_status(root,'waiting_for_job');time.sleep(5);continue
                runner_status(root,'running',evaluation_id=job['id'])
                execute(client,base,root,job)
                idle_checks=0
            except Exception as exc:
                print('Runner retry:',type(exc).__name__,flush=True);time.sleep(10)


def execute(client,base,root,job):
    import shutil
    folder=root/job['id'];folder.mkdir(exist_ok=True)
    progress=folder/'progress.json';progress.unlink(missing_ok=True)
    proc=None;url=base+'/'+job['id'];last_ack=time.monotonic();started=last_ack
    try:
        with client.stream('GET',url+'/checkpoint',params={'lease':job['lease']},timeout=120) as response:
            response.raise_for_status()
            with (folder/'model.pt').open('wb') as f:
                for chunk in response.iter_bytes():f.write(chunk)
        job.update(checkpoint=str((folder/'model.pt').resolve()),device=os.environ.get('TRACK_BENCHMARK_DEVICE','cuda'))
        spec=folder/'job.json';spec.write_text(json.dumps(job))
        with (folder/'worker.log').open('w') as log:
            proc=subprocess.Popen([sys.executable,'-m','fabryka_track.benchmark_agent','--child',str(spec),str(progress)],stdout=log,stderr=log)
            while True:
                data=json.loads(progress.read_text()) if progress.exists() else {}
                data.pop('ended_at',None)
                timeout=int(os.environ.get('TRACK_BENCHMARK_TIMEOUT_SECONDS','7200'))
                if time.monotonic()-started>timeout:data.update(status='failed',error='GPU evaluation exceeded its configured time limit')
                if proc.poll() is not None and data.get('status','running')=='running':data.update(status='failed',error='GPU worker exited before completing evaluation')
                try:
                    response=client.post(url+'/progress',json={**data,'lease':job['lease']})
                    if response.status_code==409:return
                    response.raise_for_status();last_ack=time.monotonic()
                    if data.get('status') in ('finished','failed'):
                        print(job['id'],data['status'],flush=True)
                        # Keep bounded failure diagnostics; successful checkpoint copy is disposable.
                        if data['status']=='failed':(root/'last-failure.log').write_bytes((folder/'worker.log').read_bytes()[-200000:])
                        return
                except httpx.HTTPError:
                    if time.monotonic()-last_ack>60:return
                time.sleep(5)
    finally:
        if proc and proc.poll() is None:
            proc.terminate()
            try:proc.wait(timeout=10)
            except subprocess.TimeoutExpired:proc.kill();proc.wait()
        shutil.rmtree(folder,ignore_errors=True)

if __name__=='__main__':
    if len(sys.argv)>1 and sys.argv[1]=='--child':child(Path(sys.argv[2]),Path(sys.argv[3]))
    else:main()
