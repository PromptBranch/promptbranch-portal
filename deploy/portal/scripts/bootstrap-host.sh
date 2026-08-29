#!/usr/bin/env bash
set -Eeuo pipefail

if [[ "$(id -u)" != "0" ]]; then
  echo "run as root" >&2
  exit 1
fi

if [[ $# -ne 1 ]]; then
  echo "usage: bootstrap-host.sh /path/to/staged-host-files" >&2
  exit 1
fi

host_files=$1
dev_password=$(cat)
if [[ -z "$dev_password" ]]; then
  echo "a non-empty dev password is required on stdin" >&2
  exit 1
fi

export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y \
  ca-certificates \
  curl \
  fail2ban \
  gnupg \
  unattended-upgrades \
  ufw

if ! id dev >/dev/null 2>&1; then
  useradd --create-home --user-group --shell /bin/bash dev
fi
usermod --append --groups sudo dev
printf 'dev:%s\n' "$dev_password" | chpasswd
unset dev_password

install -d -m 0755 /etc/apt/keyrings
curl --fail --silent --show-error --location \
  https://download.docker.com/linux/ubuntu/gpg \
  --output /etc/apt/keyrings/docker.asc
chmod a+r /etc/apt/keyrings/docker.asc

. /etc/os-release
docker_suite=${UBUNTU_CODENAME:-${VERSION_CODENAME:?missing Ubuntu codename}}
docker_arch=$(dpkg --print-architecture)
printf '%s\n' \
  "deb [arch=${docker_arch} signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu ${docker_suite} stable" \
  > /etc/apt/sources.list.d/docker.list

apt-get update
apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin

install -d -m 0755 /etc/docker
install -m 0644 "$host_files/docker/daemon.json" /etc/docker/daemon.json
install -d -m 0755 /etc/fail2ban/jail.d
install -m 0644 "$host_files/fail2ban/sshd.local" /etc/fail2ban/jail.d/promptbranch-sshd.local
install -m 0644 "$host_files/apt/20auto-upgrades" /etc/apt/apt.conf.d/20auto-upgrades
install -d -m 0755 /etc/ssh/sshd_config.d
install -m 0644 "$host_files/sshd/00-promptbranch-hardening.conf" /etc/ssh/sshd_config.d/00-promptbranch-hardening.conf
rm -f /etc/ssh/sshd_config.d/99-promptbranch-hardening.conf

usermod --append --groups docker dev
install -d -m 0700 -o dev -g dev /home/dev/.ssh
if [[ ! -s /root/.ssh/authorized_keys ]]; then
  echo "root authorized_keys is missing; refusing to continue" >&2
  exit 1
fi
install -m 0600 -o dev -g dev /root/.ssh/authorized_keys /home/dev/.ssh/authorized_keys
install -d -m 0750 -o dev -g dev /home/dev/promptbranch

systemctl daemon-reload
systemctl enable --now docker
systemctl restart docker
docker info >/dev/null

ufw default deny incoming
ufw default allow outgoing
ufw allow 22/tcp comment 'OpenSSH'
ufw allow 80/tcp comment 'HTTP for NPM and ACME'
ufw allow 443/tcp comment 'HTTPS for NPM'
ufw --force enable

systemctl enable --now fail2ban
systemctl enable --now unattended-upgrades

sshd -t
if ss -lnt | grep -Eq '(^|[[:space:]])[^ ]*:2375([[:space:]]|$)|(^|[[:space:]])[^ ]*:2376([[:space:]]|$)'; then
  echo "Docker TCP API unexpectedly exposed" >&2
  exit 1
fi

echo "host bootstrap complete; SSH hardening is staged and ready to reload after dev key verification"
