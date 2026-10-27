#!/bin/bash
# Explicit user-level SSH service. No action occurs unless start is requested.
set -euo pipefail
umask 077
state="$HOME/.local/share/cloudflare-ssh-mcp"
config="$state/sshd_config"
pidfile="$state/sshd.pid"
action="${1:-status}"

running() {
  [[ -f "$pidfile" && ! -L "$pidfile" ]] || return 1
  pid=$(cat "$pidfile")
  [[ "$pid" =~ ^[0-9]+$ ]] || return 1
  [[ "$(ps -p "$pid" -o uid= | tr -d ' ')" = "$(id -u)" ]] || return 1
  command=$(ps -p "$pid" -o command=)
  [[ "$command" = *"/usr/sbin/sshd -D -e -f $config"* ]]
}

case "$action" in
  status)
    if running; then echo "running pid=$pid endpoint=127.0.0.1:22222"; else echo "stopped"; fi
    ;;
  stop)
    if running; then
      kill -TERM "$pid"
      echo "stop requested pid=$pid"
    else echo "stopped"; fi
    ;;
  start|prepare|serve)
    [[ "$(uname -s)" = Darwin ]] || { echo 'macOS is required' >&2; exit 1; }
    # Check every managed path before mkdir/chmod, key generation or redirection.
    # -L also catches dangling links, which -e alone would treat as absent.
    [[ ! -L "$state" ]] || { echo 'Refusing symlink state directory' >&2; exit 1; }
    for name in host_ed25519 host_ed25519.pub id_ed25519 id_ed25519.pub authorized_keys sshd_config sshd.pid sshd.log; do
      path="$state/$name"
      if [[ -L "$path" || ( -e "$path" && ! -f "$path" ) ]]; then
        echo "Refusing symlink or non-file service path: $name" >&2; exit 1
      fi
    done
    was_running=false
    if running; then
      was_running=true
      # Reusing a process still requires checking all persisted service inputs.
      for name in host_ed25519 host_ed25519.pub id_ed25519 id_ed25519.pub authorized_keys sshd_config; do
        [[ -f "$state/$name" ]] || { echo "Running service file missing: $name" >&2; exit 1; }
      done
    fi
    if [[ "$was_running" = false ]] && /usr/sbin/lsof -nP -iTCP:22222 -sTCP:LISTEN >/dev/null 2>&1; then
      echo 'Port 22222 is already in use; no files changed' >&2; exit 1
    fi
    mkdir -p "$state"
    [[ "$(stat -f %u "$state")" = "$(id -u)" ]] || { echo 'State directory has another owner' >&2; exit 1; }
    chmod 700 "$state"
    for name in host_ed25519 id_ed25519; do
      if [[ ! -e "$state/$name" && ! -e "$state/$name.pub" ]]; then
        /usr/bin/ssh-keygen -q -t ed25519 -N '' -C cloudflare-ssh-mcp -f "$state/$name"
      elif [[ ! -f "$state/$name" || ! -f "$state/$name.pub" || -L "$state/$name" || -L "$state/$name.pub" ]]; then
        echo "Incomplete or symlink key pair: $name; inspect manually" >&2; exit 1
      fi
    done
    if [[ ! -e "$state/authorized_keys" ]]; then
      { printf 'restrict '; cat "$state/id_ed25519.pub"; } > "$state/authorized_keys"
    fi
    # Refuse unrelated keys rather than silently widening access.
    expected="restrict $(cat "$state/id_ed25519.pub")"
    [[ "$(cat "$state/authorized_keys")" = "$expected" ]] || { echo 'authorized_keys differs from the dedicated public key' >&2; exit 1; }
    if [[ ! -e "$config" ]]; then
      cat > "$config" <<EOF
Port 22222
ListenAddress 127.0.0.1
HostKey "$state/host_ed25519"
PidFile "$pidfile"
AuthorizedKeysFile "$state/authorized_keys"
AllowUsers $(id -un)
PubkeyAuthentication yes
AuthenticationMethods publickey
PasswordAuthentication no
KbdInteractiveAuthentication no
PermitRootLogin no
UsePAM no
StrictModes yes
DisableForwarding yes
PermitTTY no
PermitUserRC no
EOF
    fi
    chmod 600 "$config" "$state/authorized_keys" "$state/host_ed25519" "$state/id_ed25519"
    /usr/sbin/sshd -t -f "$config"
    # Verify existing configuration still matches this service's limited scope.
    effective=$(/usr/sbin/sshd -T -f "$config")
    for required in 'port 22222' 'listenaddress 127.0.0.1:22222' 'passwordauthentication no' 'kbdinteractiveauthentication no' 'disableforwarding yes' 'authenticationmethods publickey' 'permituserrc no' 'permittty no' 'usepam no' "allowusers $(id -un)" "hostkey $state/host_ed25519" "authorizedkeysfile $state/authorized_keys"; do
      [[ $(printf '%s\n' "$effective" | /usr/bin/grep -Fxc "$required") = 1 ]] || { echo "Unexpected sshd setting: $required" >&2; exit 1; }
    done
    [[ $(printf '%s\n' "$effective" | /usr/bin/grep -c '^listenaddress ') = 1 ]] || { echo 'Unexpected additional listener' >&2; exit 1; }
    if [[ "$action" = prepare ]]; then echo "SSH files validated; no service started or restarted"; exit 0; fi
    if [[ "$was_running" = true ]]; then
      echo "already running pid=$pid; files validated"
      [[ "$action" != serve ]]
      exit $?
    fi
    if [[ "$action" = serve ]]; then exec /usr/sbin/sshd -D -e -f "$config"; fi
    /usr/sbin/sshd -D -e -f "$config" >> "$state/sshd.log" 2>&1 &
    pid=$!
    echo "$pid" > "$pidfile"
    sleep 0.3
    if running; then echo "running pid=$pid endpoint=127.0.0.1:22222"; else echo "sshd failed; inspect $state/sshd.log" >&2; exit 1; fi
    ;;
  *) echo "Usage: $0 {status|prepare|start|serve|stop}" >&2; exit 2 ;;
esac
