#!/usr/bin/python3
"""Native messaging host for Market Helper's Update button.

Chrome starts this when the panel asks for an update. It runs `git pull` in the
folder the extension was loaded from and replies with the result. It does nothing
else, whatever message it is sent.
"""
import json
import os
import struct
import subprocess
import sys

REPO = os.path.dirname(os.path.dirname(os.path.realpath(__file__)))


def pull():
    # Chrome gives hosts a bare PATH; add the usual places git lives.
    env = dict(os.environ, GIT_TERMINAL_PROMPT='0')
    env['PATH'] = os.pathsep.join([env.get('PATH', ''), '/usr/bin', '/usr/local/bin', '/opt/homebrew/bin'])
    try:
        result = subprocess.run(
            ['git', '-C', REPO, 'pull', '--ff-only'],
            env=env, capture_output=True, text=True, timeout=60, stdin=subprocess.DEVNULL,
        )
    except (OSError, subprocess.TimeoutExpired) as error:
        return {'ok': False, 'output': str(error)}
    return {'ok': result.returncode == 0, 'output': (result.stdout + result.stderr).strip()}


def main():
    size = sys.stdin.buffer.read(4)
    if len(size) == 4:
        sys.stdin.buffer.read(struct.unpack('<I', size)[0])
    reply = json.dumps(pull()).encode()
    sys.stdout.buffer.write(struct.pack('<I', len(reply)) + reply)
    sys.stdout.buffer.flush()


if __name__ == '__main__':
    main()
