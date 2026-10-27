#!/usr/bin/env python3
"""Explicit LaunchAgent management for this Mac's SSH and Tunnel connector."""
import os
import pathlib
import plistlib
import stat
import subprocess
import sys

state = pathlib.Path.home() / '.local/share/cloudflare-ssh-mcp'
source = pathlib.Path(__file__).resolve().parent
agents = pathlib.Path.home() / 'Library/LaunchAgents'
domain = f'gui/{os.getuid()}'
labels = ['local.cloudflare-ssh-mcp.ssh', 'local.cloudflare-ssh-mcp.tunnel']
action = sys.argv[1] if len(sys.argv) == 2 else 'status'


def run(*args, check=True, quiet=False):
    return subprocess.run(args, check=check, stdout=subprocess.DEVNULL if quiet else None,
                          stderr=subprocess.DEVNULL if quiet else None)


def definitions():
    commands = [
        ['/usr/sbin/sshd', '-D', '-e', '-f', str(state / 'sshd_config')],
        [str(state / 'bin/cloudflared'), 'tunnel', '--no-autoupdate',
         '--protocol', 'quic', '--metrics', '127.0.0.1:0',
         'run', '--token-file', str(state / 'tunnel-token')],
    ]
    return [dict(Label=label, ProgramArguments=command, RunAtLoad=True, KeepAlive=True,
                 ThrottleInterval=10, ProcessType='Background',
                 WorkingDirectory=str(state), Umask=0o077,
                 StandardOutPath=str(state / (label + '.log')),
                 StandardErrorPath=str(state / (label + '.log')))
            for label, command in zip(labels, commands)]


def prepare():
    if state.is_symlink():
        raise SystemExit('Refusing symlink state directory')
    state.mkdir(parents=True, exist_ok=True, mode=0o700)
    if state.stat().st_uid != os.getuid():
        raise SystemExit('State directory has another owner')
    state.chmod(0o700)
    target = state / 'launchagents'
    if target.is_symlink():
        raise SystemExit('Refusing symlink preview directory')
    target.mkdir(exist_ok=True, mode=0o700)
    for definition in definitions():
        path = target / (definition['Label'] + '.plist')
        data = plistlib.dumps(definition)
        if path.exists() or path.is_symlink():
            if path.is_symlink() or path.read_bytes() != data:
                raise SystemExit(f'Existing preview differs; inspect {path}')
        else:
            with path.open('xb') as output:
                output.write(data)
            path.chmod(0o600)
        run('/usr/bin/plutil', '-lint', str(path))
    print(f'Prepared {target}; services remain unloaded; no SSH keys generated')


if action == 'prepare':
    prepare()
elif action == 'enable':
    # Do not inspect or print token contents.
    token = state / 'tunnel-token'
    if token.is_symlink() or not token.is_file():
        raise SystemExit('Protected tunnel-token file is required')
    info = token.stat()
    if info.st_uid != os.getuid() or stat.S_IMODE(info.st_mode) & 0o077:
        raise SystemExit('tunnel-token must belong to the current user with mode 600 or stricter')
    if not os.access(state / 'bin/cloudflared', os.X_OK):
        raise SystemExit('cloudflared executable is missing')
    prepare()
    agents.mkdir(parents=True, exist_ok=True)
    # Inspect both destinations before changing either one.
    for label in labels:
        target = agents / (label + '.plist')
        preview = state / 'launchagents' / target.name
        if target.is_symlink() or (target.exists() and target.read_bytes() != preview.read_bytes()):
            raise SystemExit(f'Existing LaunchAgent differs; inspect {target}')
    run('/bin/bash', str(source / 'mac-ssh.sh'), 'prepare')
    for label in labels:
        target = agents / (label + '.plist')
        if not target.exists():
            with target.open('xb') as output:
                output.write((state / 'launchagents' / target.name).read_bytes())
            target.chmod(0o600)
        run('/bin/launchctl', 'enable', f'{domain}/{label}')
        if run('/bin/launchctl', 'print', f'{domain}/{label}', check=False, quiet=True).returncode:
            run('/bin/launchctl', 'bootstrap', domain, str(target))
    print('LaunchAgents loaded; use status and verify SSH/Tunnel connectivity')
elif action == 'disable':
    for label in labels:
        run('/bin/launchctl', 'disable', f'{domain}/{label}')
        if run('/bin/launchctl', 'print', f'{domain}/{label}', check=False, quiet=True).returncode == 0:
            run('/bin/launchctl', 'bootout', f'{domain}/{label}')
    print('LaunchAgents disabled and unloaded; private files retained')
elif action == 'status':
    for label in labels:
        result = run('/bin/launchctl', 'print', f'{domain}/{label}', check=False, quiet=True)
        print(label + (': loaded (inspect logs and connectivity)' if result.returncode == 0 else ': unloaded'))
else:
    raise SystemExit('Usage: mac-services.py {prepare|enable|disable|status}')
