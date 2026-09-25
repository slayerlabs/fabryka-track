#!/usr/bin/env python3
"""CPU-only sidecar: forward existing JSONL events, without touching training."""
import argparse
import json
import os
import time
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

KINDS = {'update', 'checkpoint', 'evaluation', 'end', 'failed'}


def process_identity(pid):
    try:
        text = Path(f'/proc/{pid}/stat').read_text()
        tail = text[text.rfind(')') + 2:].split()
        return None if tail[0] == 'Z' else tail[19]
    except FileNotFoundError:
        return None


def read_batch(path, state, maximum=200):
    events = []
    offset, line = state.get('offset', 0), state.get('line', 0)
    with path.open('rb') as source:
        source.seek(offset)
        while len(events) < maximum:
            raw = source.readline()
            if not raw or not raw.endswith(b'\n'):
                break  # A partial trailing line is retried on the next pass.
            item = json.loads(raw)
            line += 1
            offset = source.tell()
            if item.get('kind') not in KINDS:
                continue
            event = {'line': line, 'kind': item['kind'], 'step': item.get('updates', 0),
                     'tokens': item.get('tokens', 0)}
            if item['kind'] in ('update', 'evaluation'):
                event['metrics'] = {k: v for k, v in item.get('metrics', {}).items()
                                    if k in ('loss', 'tokens_per_second', 'gradient_norm', 'gradient_norm_after_clip', 'gradient_clip_threshold', 'gradient_clipped', 'learning_rate', 'bpb')}
            if item['kind'] == 'checkpoint': event['sha256'] = item['sha256']
            if item['kind'] == 'end': event['status'] = item['status']
            events.append(event)
    return events, {**state, 'offset': offset, 'line': line}


def signal_stop(path):
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + '.tmp')
    temporary.write_text('Track stop requested. Save a checkpoint, emit end: paused, and exit.\n')
    temporary.replace(path)


def sync_once(args, state, send, control=None):
    stat = args.events.stat()
    identity = [stat.st_dev, stat.st_ino]
    if state.get('file_identity', identity) != identity or stat.st_size < state.get('offset', 0):
        raise RuntimeError('Source log changed identity or was truncated; refusing to mix histories')
    events, next_state = read_batch(args.events, state)
    current_process = process_identity(args.pid)
    expected = state.get('process_identity', current_process)
    # Persist initial identity before the first request so a retry cannot adopt a reused PID.
    next_state.update(file_identity=identity, process_identity=expected)
    payload = {'events': events, 'source_updated_at': datetime.fromtimestamp(stat.st_mtime, timezone.utc).isoformat(),
               'process_alive': current_process is not None and current_process == expected}
    send(payload)
    if control is not None and control() and args.stop_file:
        signal_stop(args.stop_file)
    return next_state, len(events) == 200 and next_state['offset'] < stat.st_size, len(events)


def save_state(path, state):
    temp = path.with_suffix('.tmp')
    with temp.open('w') as f:
        json.dump(state, f); f.flush(); os.fsync(f.fileno())
    temp.replace(path)


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--events', type=Path, required=True)
    p.add_argument('--state', type=Path, required=True)
    p.add_argument('--pid', type=int, required=True)
    p.add_argument('--url', default='https://track.fabryka.ai')
    p.add_argument('--run-id', required=True)
    p.add_argument('--stop-file', type=Path, help='Marker written after an owner presses Stop in Track.')
    p.add_argument('--interval', type=float, default=15)
    p.add_argument('--once', action='store_true')
    args = p.parse_args()
    token = os.environ['TRACK_TRAINING_TOKEN']
    stat = args.events.stat()
    state = json.loads(args.state.read_text()) if args.state.exists() else {
        'process_identity': process_identity(args.pid), 'file_identity': [stat.st_dev, stat.st_ino]}
    if not args.state.exists(): save_state(args.state, state)

    def send(payload):
        request = urllib.request.Request(args.url.rstrip('/') + '/api/external-training/' + args.run_id + '/progress',
                  data=json.dumps(payload, allow_nan=False).encode(),
                  headers={'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json'})
        with urllib.request.urlopen(request, timeout=30) as response:
            json.load(response)

    def control():
        request = urllib.request.Request(args.url.rstrip('/') + '/api/external-training/' + args.run_id + '/control',
                  headers={'Authorization': 'Bearer ' + token})
        with urllib.request.urlopen(request, timeout=30) as response:
            return bool(json.load(response).get('stop'))

    while True:
        try:
            state, more, count = sync_once(args, state, send, control)
            save_state(args.state, state)
            print(json.dumps({'synced_line': state['line'], 'events': count}), flush=True)
            if args.once and not more: return
            if more: continue
        except Exception as exc:
            print(json.dumps({'sync_error': type(exc).__name__}), flush=True)
            if args.once: raise
        time.sleep(args.interval)


if __name__ == '__main__':
    main()
