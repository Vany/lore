# lore — deployment.
#
# Copy this folder to the host, put a .env beside it, and `make up`.
#
#   make up                                    build and start everything
#   make new NAME=vany GIT=git@github.com:o/r  provision a repo and token
#   make status                                is parallelism running, or queueing?
#   make logs                                  follow
#   make restore                               pull the database back from backup
#
# Targets that could lose data (`down-hard`, `restore`) ask first. Everything else
# is safe to re-run.

COMPOSE ?= docker compose
DATA    ?= $(shell grep -E '^LORE_HOST_DATA=' .env 2>/dev/null | cut -d= -f2)
DATA    := $(if $(DATA),$(DATA),/var/lib/lore)

.DEFAULT_GOAL := help
.PHONY: help preflight sync-opencode push build up down down-hard restart logs status doctor new tokens backup-check restore sweep shell

help:
	@sed -n '2,14p' $(MAKEFILE_LIST) | sed 's/^# \{0,1\}//'

## Fail early and legibly, rather than midway through a build.
preflight:
	@test -f .env || { echo "no .env — copy .env.example and fill it in"; exit 1; }
	@grep -qE '^(OPENROUTER_API_KEY|ZHIPU_API_KEY)=.+' .env || { echo "no model provider key in .env — set OPENROUTER_API_KEY or ZHIPU_API_KEY"; exit 1; }
	@grep -qE '^OPENCODE_SERVER_PASSWORD=.+' .env || { echo "OPENCODE_SERVER_PASSWORD is empty in .env — the server would answer a bare 401 with no hint"; exit 1; }
	@grep -qE '^LITESTREAM_ACCESS_KEY_ID=.+' .env || echo "WARNING: no backup configured. The knowledge base IS the product and this box has no redundancy."
	@mkdir -p "$(DATA)"
	@echo "preflight ok — data at $(DATA)"

## Stage this machine's opencode config for the container, minus Anthropic.
sync-opencode:
	@./sync-opencode.sh ./opencode

## Ship the deployment to the host. Credentials travel over the tailnet only.
push: sync-opencode
	@test -n "$(HOST)" || { echo "usage: make push HOST=<ssh-host> [DIR=~/lore]"; exit 1; }
	rsync -az --delete --exclude .env \
		./ "$(HOST):$(if $(DIR),$(DIR),lore)/"
	@echo "pushed. On the host:  cd $(if $(DIR),$(DIR),lore) && make up"

build: preflight
	$(COMPOSE) --profile build-only build

up: preflight
	@test -f ./opencode/data/auth.json || { echo "no staged opencode config — run 'make sync-opencode' on the machine that has it"; exit 1; }
	$(COMPOSE) --profile build-only build sandbox
	$(COMPOSE) up -d --build
	@echo
	@echo "up. next:  make new NAME=<who> GIT=<ssh-url>"

## Stops the containers. Data survives — it is a host bind, not a volume.
down:
	$(COMPOSE) down

## Also deletes the repositories, worktrees and THE KNOWLEDGE BASE.
down-hard:
	@echo "This deletes $(DATA) — every repo, every review, and the knowledge base."
	@echo "That is everything the workgroup has taught lore. Backups are the only way back."
	@printf 'Type the data path to confirm: ' && read ans && [ "$$ans" = "$(DATA)" ] || { echo "aborted"; exit 1; }
	$(COMPOSE) down -v
	rm -rf "$(DATA)"

restart:
	$(COMPOSE) restart lore

logs:
	$(COMPOSE) logs -f --tail=100

## Provision a repo: read-only deploy key, revocable token, client config.
new: preflight
	@test -n "$(NAME)" || { echo "usage: make new NAME=<who> GIT=<ssh-url> [URL=<mcp-url>]"; exit 1; }
	@test -n "$(GIT)"  || { echo "usage: make new NAME=<who> GIT=<ssh-url> [URL=<mcp-url>]"; exit 1; }
	$(COMPOSE) exec -T lore node /app/src/index.ts new \
		--name "$(NAME)" --git "$(GIT)" --db /var/lib/lore/lore.db \
		$(if $(URL),--url "$(URL)",)

## Check tiers, auth and model ids BEFORE spending a review on them.
doctor:
	$(COMPOSE) exec -T lore node /app/src/index.ts doctor

## The operator view: active reviews, queue depth, spend, disk.
status:
	@curl -fsS http://127.0.0.1:7777/status | python3 -m json.tool 2>/dev/null \
		|| echo "not reachable — is it up? (make logs)"

tokens:
	@$(COMPOSE) exec -T lore node -e "\
	const {DatabaseSync}=require('node:sqlite'); \
	const d=new DatabaseSync('/var/lib/lore/lore.db'); \
	for (const r of d.prepare('SELECT principal, label, created_at, revoked_at FROM token').all()) \
	  console.log(r.revoked_at ? '[revoked]' : '[live]   ', r.principal, r.label ?? '', r.created_at);"

## Is the backup real, or just configured? Untested backups are beliefs.
backup-check:
	@$(COMPOSE) exec -T litestream litestream snapshots /var/lib/lore/lore.db \
		|| echo "no snapshots — the knowledge base is NOT backed up"

## Restore from backup. Overwrites the live database.
restore:
	@echo "This overwrites $(DATA)/lore.db with the newest replica."
	@printf 'Type RESTORE to confirm: ' && read ans && [ "$$ans" = "RESTORE" ] || { echo "aborted"; exit 1; }
	$(COMPOSE) stop lore
	$(COMPOSE) run --rm litestream restore -o /var/lib/lore/lore.db /var/lib/lore/lore.db
	$(COMPOSE) start lore
	@echo "restored. Verify with: make status"

## Force the retention sweep rather than waiting for the hourly one.
sweep:
	$(COMPOSE) exec -T lore node -e "\
	import('/app/src/ops/retention.ts').then(async m => { \
	  const {Store} = await import('/app/src/store/store.ts'); \
	  const s = new Store('/var/lib/lore/lore.db'); \
	  console.log(await m.collect(s, {...m.DEFAULT_RETENTION, reposRoot: '/var/lib/lore/repos'})); \
	  s.close(); });"

shell:
	$(COMPOSE) exec lore sh
