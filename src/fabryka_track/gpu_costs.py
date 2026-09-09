"""Pod-only costs: provider billing snapshots and explicitly labelled estimates."""
from datetime import timedelta
from decimal import Decimal
import logging
import time

from sqlalchemy import select

from .database import SessionLocal
from .models import GPUJob, Run, now
from .settings import settings

_last_refresh = 0.0


def cost_summary(job, run):
    meta = run.metadata_
    billing = meta.get('pod_billing')
    if not job.pod_id:
        return {'estimated_usd': 0.0 if job.cleanup_done else None,
                'billed_usd': None, 'seconds': 0, 'basis': 'no_pod', 'complete': job.cleanup_done}
    rate = meta.get('hourly_usd')
    seconds = None
    # deadline is reset on each allocation attempt, excluding earlier queue waits.
    runtime = min(run.config.get('max_runtime_seconds', 3600), settings.runpod_max_seconds)
    start = job.deadline - timedelta(seconds=runtime)
    end = run.ended_at if job.cleanup_done else now()
    if end:
        from .gpu_training import utc
        seconds = max(0.0, (utc(end) - utc(start)).total_seconds())
    estimate = float(Decimal(str(rate)) * Decimal(str(seconds)) / 3600) if rate is not None and seconds is not None else None
    return {'estimated_usd': estimate, 'seconds': seconds, 'hourly_usd': rate,
            'basis': 'allocation_attempt_to_cleanup', 'complete': job.cleanup_done,
            'billed_usd': billing.get('amount_usd') if billing else None,
            'billed_seconds': billing.get('seconds') if billing else None,
            'billing_checked_at': billing.get('checked_at') if billing else None}


def refresh_billing(force=False):
    """One account-level request per five minutes, never in a page request."""
    global _last_refresh
    current = time.monotonic()
    if not force and current - _last_refresh < 300:
        return
    _last_refresh = current
    from .gpu_training import provider, utc
    try:
        with SessionLocal() as session:
            jobs = list(session.scalars(select(GPUJob).where(GPUJob.pod_id.is_not(None))))
            if not jobs:
                return
            start = min(utc(j.created_at) for j in jobs).replace(hour=0, minute=0, second=0, microsecond=0)
            rows = provider('GET', '/billing/pods', params={
                'grouping': 'podId', 'bucketSize': 'day',
                'startTime': start.isoformat(), 'endTime': now().isoformat()})
            totals = {}
            for row in rows:
                pod_id = row.get('podId')
                if pod_id not in {j.pod_id for j in jobs}:
                    continue
                amount, milliseconds = totals.get(pod_id, (Decimal(0), Decimal(0)))
                totals[pod_id] = (amount + Decimal(str(row['amount'])),
                                  milliseconds + Decimal(str(row.get('timeBilledMs') or 0)))
            for job in jobs:
                if job.pod_id not in totals:
                    continue  # Missing billing is unknown, never a zero charge.
                run = session.get(Run, job.run_id)
                amount, milliseconds = totals[job.pod_id]
                run.metadata_ = {**run.metadata_, 'pod_billing': {
                    'amount_usd': float(amount), 'seconds': float(milliseconds / 1000),
                    'checked_at': now().isoformat(), 'source': 'runpod_billing'}}
            session.commit()
    except Exception as exc:
        # No credentials, provider bodies or request objects in logs.
        logging.getLogger(__name__).warning('RunPod billing refresh failed (%s)', type(exc).__name__)
