"""Import completed White evaluations as reference runs, without enqueueing GPU work."""
import argparse
from datetime import datetime
from uuid import NAMESPACE_URL, uuid5

import httpx
from sqlalchemy import select

from fabryka_track.database import SessionLocal
from fabryka_track.models import Project, Run, WhiteBenchmark


def import_references(url, apply=False):
    response = httpx.get(url.rstrip('/') + '/api/leaderboard', timeout=20)
    response.raise_for_status()
    entries = [entry for entry in response.json()['entries']
               if entry['status'] == 'complete' and entry['scope'] == 'full']
    if not apply:
        for item in entries:
            print(item['model'], item['revision'], 'existing evaluation', item['id'])
        return len(entries)
    with SessionLocal() as session:
        project = session.scalar(select(Project).where(Project.name == 'White benchmark references'))
        if apply and project is None:
            project = Project(name='White benchmark references')
            session.add(project); session.flush()
        for item in entries:
            rid = str(uuid5(NAMESPACE_URL, 'white-benchmark-reference:' + item['model'] + '@' + item['revision']))
            print(item['model'], item['revision'], 'existing evaluation', item['id'], 'Track run', rid)
            if not apply or session.get(Run, rid):
                continue
            session.add(Run(id=rid, project_id=project.id, name='Reference: ' + item['model'],
                            is_public=True, state='finished',
                            config={'model': item['model'], 'parameters': item.get('num_params')},
                            metadata_={'engine': 'benchmark-reference'},
                            started_at=datetime.fromisoformat(item['created_at']),
                            ended_at=datetime.fromisoformat(item['finished_at'])))
            session.flush()
            session.add(WhiteBenchmark(run_id=rid, repo_id=item['model'], revision=item['revision'],
                                       job_id=item['id'], status='complete', source_kind='reference',
                                       result={key: item.get(key) for key in ('metrics', 'benchmarks', 'scope', 'num_params')}))
        if apply:
            session.commit()
    return len(entries)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--url', required=True)
    parser.add_argument('--apply', action='store_true')
    args = parser.parse_args()
    import_references(args.url, args.apply)
