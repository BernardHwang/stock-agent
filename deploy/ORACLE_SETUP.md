# Deploying to Oracle Cloud Always Free

Two free VMs in one virtual network:

| VM | Shape | Runs |
|---|---|---|
| **A** | VM.Standard.E2.1.Micro (AMD, 1 GB) | moomoo OpenD (x86-64 only) |
| **B** | VM.Standard.A1.Flex (ARM, e.g. 2 OCPU / 12 GB) | stockagent (Docker) |

If moomoo later ships an ARM build of OpenD, you can run both on VM B.

## 1. Create the VMs

1. Sign up at cloud.oracle.com (card needed for identity; Always Free resources are not charged).
2. Create a VCN with the wizard ("VCN with Internet Connectivity").
3. Create VM A and VM B with **Ubuntu 24.04** in that VCN's public subnet, with your SSH key.
4. Note each VM's **private IP** (e.g. `10.0.0.10` for A, `10.0.0.20` for B).

## 2. Firewall (security list)

Ingress rules only:

| Source | Port | Why |
|---|---|---|
| your home IP `/32` | 22 | SSH |
| VM B private IP `/32` | 11111 | stockagent → OpenD |

Nothing else. OpenD must never be reachable from the internet. Ubuntu images on Oracle also have
iptables rules; on VM A allow the port from VM B:

```bash
sudo iptables -I INPUT -p tcp -s 10.0.0.20 --dport 11111 -j ACCEPT
sudo netfilter-persistent save
```

## 3. OpenD on VM A

1. Download the **command-line OpenD for Ubuntu** from moomoo's OpenAPI page and copy it to `/opt/opend`.
2. Create a service user: `sudo useradd --system opend && sudo chown -R opend /opt/opend`.
3. Edit `/opt/opend/OpenD.xml`: login account and password (as the current OpenD release documents),
   `api_ip` = VM A's private IP, `api_port` = 11111, `telnet_ip` = 127.0.0.1, `telnet_port` = 22222.
4. First start in the foreground to complete the SMS verification: `cd /opt/opend && ./OpenD`.
5. Install the service: `sudo cp deploy/opend.service /etc/systemd/system/ && sudo systemctl enable --now opend`.

### When Telegram says "OpenD not logged in. It may need SMS verification."

```bash
ssh ubuntu@VM_A
telnet 127.0.0.1 22222
req_phone_verify_code          # moomoo sends an SMS
input_phone_verify_code -code=123456
```

Live prices and holdings sync pause until this is done. Analyses and scheduled jobs keep running.

## 4. stockagent on VM B

```bash
sudo apt-get update && sudo apt-get install -y docker.io docker-compose-v2 git
sudo usermod -aG docker $USER && newgrp docker
git clone https://github.com/BernardHwang/stock-agent.git && cd stock-agent
cp .env.example .env && nano .env      # MOOMOO_HOST = VM A private IP, plus keys and Telegram
mkdir -p data/tradingagents && sudo chown -R 1000:1000 data
docker compose -f deploy/docker-compose.yml up -d --build
docker compose -f deploy/docker-compose.yml logs -f
```

You should get "Stock agent started" in Telegram. Send `/status`.

Update later: `git pull && docker compose -f deploy/docker-compose.yml up -d --build`.

## 5. Switching to a paid AI model

In `.env`, replace the model block. Example for OpenAI:

```
LLM_PROVIDER=openai
DEEP_MODEL=gpt-6-sol
QUICK_MODEL=gpt-6-luna
OPENAI_API_KEY=...
```

Example for Claude:

```
LLM_PROVIDER=anthropic
DEEP_MODEL=claude-sonnet-5-5
QUICK_MODEL=claude-haiku-5-5
ANTHROPIC_API_KEY=...
MAX_DEBATE_ROUNDS=2
MAX_RISK_DISCUSS_ROUNDS=2
MAX_CANDIDATES=10
MAX_RUNS_PER_DAY=20
```

Raise the `MAX_*` limits like this for any paid provider.

Then set a monthly spending cap in the provider's console and restart:
`docker compose -f deploy/docker-compose.yml up -d`.
