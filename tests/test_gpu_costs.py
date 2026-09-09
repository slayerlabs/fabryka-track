from datetime import timedelta
from types import SimpleNamespace

import pytest

from fabryka_track import gpu_costs, gpu_training
from fabryka_track.database import SessionLocal
from fabryka_track.models import GPUJob, Run, now
from test_gpu_training import enable, launch


def test_estimate_excludes_queue_and_stops_at_cleanup():
    end=now()
    job=SimpleNamespace(pod_id='pod',cleanup_done=True,deadline=end+timedelta(minutes=50))
    run=SimpleNamespace(metadata_={'hourly_usd':0.30},config={'max_runtime_seconds':3600},ended_at=end)
    result=gpu_costs.cost_summary(job,run)
    assert result['seconds']==600
    assert result['estimated_usd']==pytest.approx(0.05)
    assert result['billed_usd'] is None
    run.metadata_={}
    assert gpu_costs.cost_summary(job,run)['estimated_usd'] is None
    job.pod_id=None
    assert gpu_costs.cost_summary(job,run)['estimated_usd']==0


def test_billing_sums_only_owned_pod_and_refresh_is_idempotent(client,monkeypatch):
    enable(monkeypatch)
    run_id=launch(client).json()['id']
    with SessionLocal() as s:
        j=s.get(GPUJob,run_id);j.pod_id='owned';s.commit()
    rows=[{'podId':'owned','amount':0.02,'timeBilledMs':120000},
          {'podId':'owned','amount':0.03,'timeBilledMs':180000},
          {'podId':'other','amount':99,'timeBilledMs':999999}]
    monkeypatch.setattr(gpu_training,'provider',lambda *a,**kw:rows)
    gpu_costs.refresh_billing(force=True)
    gpu_costs.refresh_billing(force=True)
    with SessionLocal() as s:
        b=s.get(Run,run_id).metadata_['pod_billing']
        assert b['amount_usd']==pytest.approx(0.05)
        assert b['seconds']==300
    monkeypatch.setattr(gpu_training,'provider',lambda *a,**kw:[])
    gpu_costs.refresh_billing(force=True)
    with SessionLocal() as s:
        assert s.get(Run,run_id).metadata_['pod_billing']['amount_usd']==pytest.approx(0.05)
