# Deploying to Oracle Cloud Always Free (Single VM + Internal Docker Network)

Both **moomoo OpenD** and **stockagent** run together in a single `docker-compose.yml` connected by a private Docker bridge network (`stocknet`).
- **Zero exposed ports**: OpenD has **no ports published** to the host or internet (`11111` and `22222` are completely unreachable from outside Docker). Only `stockagent` can talk to `opend:11111` inside `stocknet`.
- **No passwords in files**: moomoo OpenD 10.x does not read a login from config or `.env`. You log in once at the OpenD console and let it remember the login in `data/opend` (see below).

## 1. Create One Always Free VM

1. Sign up at [cloud.oracle.com](https://cloud.oracle.com) (Always Free resources are not charged).
2. Create one **Ubuntu 24.04** VM:
   - **Recommended**: `VM.Standard.A1.Flex` (ARM, e.g. **2–4 OCPU / 12–24 GB RAM**, Always Free). Docker will run the `x86-64` OpenD container automatically via `qemu-user-static`.
   - **Alternative**: `VM.Standard.E2.1.Micro` (AMD x86-64, 1 GB RAM + 2 GB swap file).
3. **Firewall (Security List)**: Only allow **SSH (port 22)** from your IP. You do **not** need to open port `11111` anywhere.

## 2. Install Docker (and x86 emulation if on an ARM VM)

SSH into your VM and run:

```bash
sudo apt-get update && sudo apt-get install -y docker.io docker-compose-v2 git
# If your VM is ARM (VM.Standard.A1.Flex), install binfmt/qemu so it can run the x86-64 OpenD binary:
if [ "$(uname -m)" = "aarch64" ]; then
  sudo apt-get install -y qemu-user-static binfmt-support
fi
sudo usermod -aG docker $USER && newgrp docker
```

## 3. Clone & Configure `.env`

```bash
git clone https://github.com/BernardHwang/stock-agent.git && cd stock-agent
cp .env.example .env
```

Edit `.env` (`nano .env`) and fill in:
- `TELEGRAM_BOT_TOKEN` & `TELEGRAM_CHAT_ID`
- Your AI provider block (e.g. **Cloudflare Workers AI** or **Google Gemini** below)

Create the data directories and start both containers:

```bash
mkdir -p data/tradingagents data/opend && sudo chown -R 1000:1000 data
docker compose -f deploy/docker-compose.yml up -d --build
docker compose -f deploy/docker-compose.yml logs -f
```

### First login (once per server)

When the `opend` log ends with `Please enter account`, attach to its console and log in:

```bash
docker compose -f deploy/docker-compose.yml attach opend
```

Type your moomoo account, then your **plain** password (not an MD5), then `Y` to remember it. Detach with
**Ctrl+P, Ctrl+Q**; Ctrl+C would stop OpenD. The remembered login lives in `data/opend`, so restarts and rebuilds
log in by themselves.

### When Telegram says "OpenD not logged in. It may need SMS verification."

When moomoo asks to verify the device, use `telnet` **inside** the `opend` container:

```bash
docker compose -f deploy/docker-compose.yml exec opend telnet 127.0.0.1 22222
req_phone_verify_code          # moomoo sends an SMS to your phone
input_phone_verify_code -code=123456
```

## 4. Using Cloudflare Workers AI (Free Tier) or Paid AI Models

In `.env`, replace the model block.

Example for **Cloudflare Workers AI (Free 10,000 Neurons/day)**:
1. In the [Cloudflare Dashboard](https://dash.cloudflare.com/), copy your **Account ID** and create an API Token with **Workers AI Read** permission.
2. Put this block in `.env`:

```
LLM_PROVIDER=cloudflare
DEEP_MODEL=@cf/meta/llama-3.3-70b-instruct-fp8-fast
QUICK_MODEL=@cf/meta/llama-3.1-8b-instruct-fast
CLOUDFLARE_ACCOUNT_ID=your-cloudflare-account-id
CLOUDFLARE_API_TOKEN=your-cloudflare-workers-ai-token
MAX_DEBATE_ROUNDS=1
MAX_RISK_DISCUSS_ROUNDS=1
MAX_CANDIDATES=4
MAX_RUNS_PER_DAY=4
```

(`DEEP_MODEL` powers your Telegram financial advisor chat and final investment decisions on Llama 3.3 70B, while `QUICK_MODEL` uses Llama 3.1 8B Fast for the intermediate data analysts so you can run 4–5 full deep analyses + daily chat inside the 10,000 free Neurons/day limit.)

Example for OpenAI:

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
