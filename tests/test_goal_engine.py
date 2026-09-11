import json
from pathlib import Path
from types import SimpleNamespace
import sys

from fabryka_track.goal_engine import execute


class Remote:
    def __init__(self, stop=False):
        self.updates=[]
        self.stop=stop

    def report(self, goal, message='', state='running', kind='status', run_ids=None):
        self.updates.append((message,state,kind))
        return {'stop':self.stop and len(self.updates)>1, 'state':state}


def args(tmp_path, source):
    script=tmp_path/'adapter.py'
    script.write_text(source)
    return SimpleNamespace(state_dir=tmp_path, workspace=tmp_path, max_turns=2,max_seconds=20,
                           command=[sys.executable,str(script)])


def goal():
    return {'id':'test-goal','objective':'Inspect a fixture and report the result.','run_id':'run','context':[]}


def test_remote_adapter_executes_and_reports_result(tmp_path):
    a=args(tmp_path, '''import sys,json
g=json.loads(sys.stdin.readline())
assert g['protocol']=='track-goal-v1'
print(json.dumps({'type':'result','state':'completed','summary':'Verified the fixture.','next_step':'','run_ids':[]}))
''')
    remote=Remote()
    execute(remote,goal(),a)
    assert remote.updates[-1][1]=='completed'
    assert 'Verified the fixture' in remote.updates[-1][0]


def test_bad_or_missing_result_is_not_completion(tmp_path):
    remote=Remote()
    execute(remote,goal(),args(tmp_path,'print("not a result")'))
    assert remote.updates[-1][1]=='failed'


def test_stop_kills_managed_adapter(tmp_path):
    remote=Remote(stop=True)
    execute(remote,goal(),args(tmp_path,'import time; time.sleep(30)'))
    assert remote.updates[-1][1]=='cancelled'


def test_continue_is_bounded_and_not_false_completion(tmp_path):
    remote=Remote()
    execute(remote,goal(),args(tmp_path,'''import json
print(json.dumps({'type':'result','state':'continue','summary':'More work remains.','next_step':'Inspect next file.','run_ids':[]}))
'''))
    assert remote.updates[-1][1]=='blocked'
    assert not any(state=='completed' for _,state,_ in remote.updates)


def test_invalid_result_types_are_rejected(tmp_path):
    remote=Remote()
    execute(remote,goal(),args(tmp_path,'''import json
print("[]")
print(json.dumps({'type':'result','state':'completed','summary':123,'next_step':'','run_ids':[]}))
'''))
    assert remote.updates[-1][1]=='failed'


def test_missing_adapter_is_reported(tmp_path):
    remote=Remote()
    a=args(tmp_path,'')
    a.command=['/nonexistent/track-test-adapter']
    execute(remote,goal(),a)
    assert remote.updates[-1][1]=='failed'
