# lore — deployment.
#
# Copy this folder to the host, put a .env beside it, and `make up`.
#
#   make up                                    build and start everything
#   make new NAME=vany GIT=git@github.com:o/r  provision a repo and token
#   make status                                what is happening, coloured
#   make status ID=rev_xxx                     one review, in full
#   make logs                                  follow
#   make restore                               pull the database back from backup
#
# Targets that could lose data (`down-hard`, `restore`) ask first. Everything else
# is safe to re-run.

COMPOSE ?= docker compose
DATA    ?= $(shell grep -E '^LORE_HOST_DATA=' .env 2>/dev/null | cut -d= -f2)
DATA    := $(if $(DATA),$(DATA),/var/lib/lore)
BACKUP  ?= $(shell grep -E '^LORE_HOST_BACKUP=' .env 2>/dev/null | cut -d= -f2)
BACKUP  := $(if $(BACKUP),$(BACKUP),./backup)

.DEFAULT_GOAL := help
.PHONY: help preflight sync-opencode push build up down down-hard restart logs status status-json status-local doctor new relocate tokens mirror backup-on backup-check backup-drill restore sweep shell

help:
	@sed -n '2,14p' $(MAKEFILE_LIST) | sed 's/^# \{0,1\}//'

## Fail early and legibly, rather than midway through a build.
preflight:
	@test -f .env || { echo "no .env — copy .env.example and fill it in"; exit 1; }
	@# Credentials normally arrive via the staged auth.json derived from this host's
	@# own opencode install. An env key is the alternative, not the requirement.
	@test -s ./opencode/data/auth.json || grep -qE '^(OPENROUTER_API_KEY|ZHIPU_API_KEY)=.+' .env \
		|| { echo "no credentials: run 'make sync-opencode', or set a provider key in .env"; exit 1; }
	@grep -qE '^OPENCODE_SERVER_PASSWORD=.+' .env || { echo "OPENCODE_SERVER_PASSWORD is empty in .env — the server would answer a bare 401 with no hint"; exit 1; }
	@mkdir -p "$(BACKUP)"
	@# The T0 sandbox asks the HOST daemon to bind-mount a review worktree into a
	@# sibling container by absolute path, so that path must mean the same thing on
	@# both sides. When it does not, Docker does not refuse — it creates an EMPTY
	@# directory and mounts that, and the first symptom is npm reporting no
	@# package-lock.json in a repository that has one. Checked here because the
	@# consequence is silent and the cause is three layers away.
	@$(COMPOSE) config 2>/dev/null | grep -A1 "source: $(DATA)$$" | grep -q "target: $(DATA)$$" \
		|| { echo "the data dir is NOT mounted at the same path inside the container."; \
		     echo "T0 test execution needs $(DATA) to mean the same thing on both sides, because the"; \
		     echo "host daemon resolves the sandbox's bind by HOST path and silently mounts an empty"; \
		     echo "directory when it does not exist. See D-60."; exit 1; }
	@mkdir -p "$(DATA)"
	@# A container uid that cannot write the data directory fails with "attempt to
	@# write a readonly database", which points at SQLite rather than at ownership.
	@grep -qE '^LORE_UID=' .env || echo "LORE_UID=$$(id -u)" >> .env
	@grep -qE '^LORE_GID=' .env || echo "LORE_GID=$$(id -g)" >> .env
	@echo "preflight ok — data at $(DATA), container uid $$(id -u)"

## Derive the container's opencode config from THIS HOST's installation.
##
## The template is the operator's own ~/.config/opencode — curated interactively,
## authenticated with `opencode auth login`. Containers get a sanitised copy so
## there is one configuration to maintain, not two that drift.
sync-opencode:
	@./sync-opencode.sh ./opencode

## Ship the deployment to the host. Credentials travel over the tailnet only.
push:
	@test -n "$(HOST)" || { echo "usage: make push HOST=<ssh-host> [DIR=~/lore]"; exit 1; }
	@# Credentials are NOT shipped. The host's own opencode installation is the
	@# template, and `make up` derives the container config from it there.
	rsync -az --delete --exclude .env --exclude opencode/ \
		./ "$(HOST):$(if $(DIR),$(DIR),lore)/deploy/"
	@echo "pushed. On the host:  cd $(if $(DIR),$(DIR),lore)/deploy && make up"

build: preflight
	$(COMPOSE) --profile build-only build

## Always re-derives the opencode config first: a container running yesterday's
## credentials while the operator has since fixed them is a confusing failure.
up: preflight sync-opencode
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

## Provision a repo: a revocable token and the .mcp.json to paste. No key is
## issued — lore does not fetch, `make mirror` does, as you (D-63).
new: preflight
	@test -n "$(NAME)" || { echo "usage: make new NAME=<who> GIT=<ssh-url> [URL=<mcp-url>]"; exit 1; }
	@test -n "$(GIT)"  || { echo "usage: make new NAME=<who> GIT=<ssh-url> [URL=<mcp-url>]"; exit 1; }
	$(COMPOSE) exec -T lore node /app/src/index.ts new \
		--name "$(NAME)" --git "$(GIT)" --db "$(DATA)/lore.db" \
		$(if $(URL),--url "$(URL)",)

## A repository MOVED: same repo, new url. Keeps its id and everything attached.
##
##   make relocate REPO=rigid-monorepo GIT=git@github.com:NewOrg/rigid-monorepo.git
##
## Not `make new`. That matches on url, so it would create a SECOND row and leave the
## reviews, findings, knowledge and tokens on the old one — a repository's memory
## split in half, silently. Undoing that here once cost a nine-table transaction.
##
## Refuses unless the new remote is REACHABLE and is the SAME repository, proved by
## sharing branch tips with the mirror we already have.
##
## The SET, not one ref: a repository that moved has usually also moved ON, so testing
## a single tip refuses the very case this exists for. The first version tested `main`
## alone and refused a genuine relocation whose main had advanced by one commit, while
## 21 of 23 other tips matched exactly. Relocating onto a different repo
## would attach one codebase's accumulated memory to another's code (D-14, D-19), and
## nothing downstream could notice.
relocate:
	@test -n "$(REPO)" || { echo "usage: make relocate REPO=<name|url|id> GIT=<new-url>"; exit 1; }
	@test -n "$(GIT)"  || { echo "usage: make relocate REPO=<name|url|id> GIT=<new-url>"; exit 1; }
	@id=$$($(COMPOSE) exec -T lore node -e "\
	const {DatabaseSync}=require('node:sqlite'); \
	const d=new DatabaseSync(process.env.LORE_DATA_DIR+'/lore.db'); \
	const w=process.argv[1]; \
	const r=d.prepare('SELECT id,name,git_url FROM repo').all().filter(x=>x.id===w||x.name===w||x.git_url===w); \
	if(r.length!==1){console.error('need exactly one match for '+JSON.stringify(w)+', got '+r.length);process.exit(1);} \
	console.log(r[0].id);" "$(REPO)" | tr -d '\r') || exit 1; \
	b="$(DATA)/repos/$$id/bare.git"; \
	echo "checking $(GIT) is reachable, as you..."; \
	git ls-remote --heads "$(GIT)" >/tmp/lore-reloc.$$$$ 2>&1 \
		|| { echo "cannot reach $(GIT):"; head -3 /tmp/lore-reloc.$$$$; rm -f /tmp/lore-reloc.$$$$; exit 1; }; \
	if [ -d "$$b/objects" ]; then \
		echo "checking it is the SAME repository..."; \
		awk '{print $$1}' /tmp/lore-reloc.$$$$ | sort -u > /tmp/lore-new.$$$$; \
		git -C "$$b" for-each-ref --format='%(objectname)' refs/remotes/origin | sort -u > /tmp/lore-old.$$$$; \
		shared=$$(comm -12 /tmp/lore-old.$$$$ /tmp/lore-new.$$$$ | wc -l | tr -d ' '); \
		rm -f /tmp/lore-new.$$$$ /tmp/lore-old.$$$$; \
		if [ "$$shared" -eq 0 ]; then \
			echo "REFUSED: $(GIT) shares NO branch tip with the mirror we already have."; \
			echo "That means it is a DIFFERENT repository, or nothing has been pushed there yet."; \
			echo "Relocating onto it would attach this repo's knowledge and reviews to other code."; \
			rm -f /tmp/lore-reloc.$$$$; exit 1; \
		fi; \
		echo "  same repository confirmed — $$shared branch tip(s) in common"; \
	else \
		echo "  no mirror yet — identity cannot be checked, and is not being claimed"; \
	fi; \
	rm -f /tmp/lore-reloc.$$$$; \
	$(COMPOSE) exec -T lore node /app/src/index.ts relocate --repo "$(REPO)" --git "$(GIT)" --db "$(DATA)/lore.db" || exit 1; \
	test -d "$$b/objects" && { git -C "$$b" remote set-url origin "$(GIT)"; echo "mirror origin repointed."; }; \
	echo "next:  make mirror REPO=$(GIT)"

## Check tiers, auth and model ids BEFORE spending a review on them.
doctor:
	$(COMPOSE) exec -T lore node /app/src/index.ts doctor

## What is happening right now, coloured, for a person.
##
## The JSON at /status answers "is parallelism running or queueing?" and stops
## there — it reports a review as `running` and will not tell you which tier is
## working, whether a tier was skipped, or that a justification was ratified. For a
## service whose one rule is that a review which did not run must never look like
## one that found nothing, that gap is the thin end of the exact ambiguity we
## refuse. `make status ID=rev_...` drills into one review.
##
## When it cannot answer it prints WHY, rather than guessing. `2>/dev/null ||
## echo "not reachable"` used to turn every failure into that one sentence: on
## 2026-08-04 the real fault was a SQLite `disk I/O error` from the host and the
## container reading the same WAL database at once, the service was up and
## answering, and the suggested fix pointed at the wrong thing entirely. A status
## command that lies about why it has no status is the failure it exists to catch.
status:
	@e=/tmp/lore-status.$$$$.err; \
	$(COMPOSE) exec -T lore node /app/src/ops/status.ts $(ID) 2>$$e; rc=$$?; \
	test $$rc -eq 0 || { echo "status could not answer. the error, not a guess:"; head -20 $$e; }; \
	rm -f $$e; \
	newest=$$(find "$(BACKUP)" -type f -newermt '-1 hour' 2>/dev/null | head -1); \
	test -n "$$newest" \
		|| printf '\033[31m!! the local replica has not been written in an hour\033[0m — the knowledge base is the product. make backup-check\n'; \
	exit $$rc

## The raw JSON, for a script rather than a person.
status-json:
	@out=$$(curl -fsS http://127.0.0.1:7777/status 2>&1) \
		&& printf '%s' "$$out" | python3 -m json.tool \
		|| { echo "status-json could not answer. the error, not a guess:"; printf '%s\n' "$$out"; exit 1; }

## Same view, straight against a local database — no container, no service.
## Development on a laptop, where lore runs as plain node.
status-local:
	@LORE_DATA_DIR=$${LORE_DATA_DIR:-$$PWD/../lore} node ../src/ops/status.ts $(ID)

tokens:
	@$(COMPOSE) exec -T lore node -e "\
	const {DatabaseSync}=require('node:sqlite'); \
	const d=new DatabaseSync('$(DATA)/lore.db'); \
	for (const r of d.prepare('SELECT principal, label, created_at, revoked_at FROM token').all()) \
	  console.log(r.revoked_at ? '[revoked]' : '[live]   ', r.principal, r.label ?? '', r.created_at);"

## The public deploy key for a repository, to paste into its forge (D-65).
##
##   make key REPO=rigid-monorepo
##
## Printed at `make new` too; this is for when that scrollback is gone. Public half
## only — the private half never leaves the container, and nothing here can print it.
key:
	@test -n "$(REPO)" || { echo "usage: make key REPO=<name|url|id>"; exit 1; }
	@$(COMPOSE) exec -T lore node -e "	const {DatabaseSync}=require('node:sqlite'); 	const {readFileSync}=require('node:fs'); 	const d=new DatabaseSync(process.env.LORE_DATA_DIR+'/lore.db'); 	const want=process.argv[1]; 	const rows=d.prepare('SELECT id, name, git_url FROM repo').all() 	  .filter(r => r.id===want || r.name===want || r.git_url.includes(want)); 	if (rows.length===0) { console.error('no registered repo matches '+JSON.stringify(want)); process.exit(1); } 	for (const r of rows) { 	  const p=process.env.LORE_DATA_DIR+'/keys/'+r.id+'_ed25519.pub'; 	  let k; try { k=readFileSync(p,'utf8').trim(); } catch { k='(none yet — generated on the next fetch)'; } 	  console.log(); console.log(r.name+'  '+r.git_url); console.log('  '+k); 	} 	console.log(); 	console.log('Add as a READ-ONLY deploy key. Leave \'Allow write access\' unticked.');" "$(REPO)"

## Clone and fetch ONE registered repository, OUT HERE, as you.
##
##   make mirror REPO=lore          match on name, url or id
##   make mirror ALL=1              every registered repo, deliberately
##
## A FALLBACK since D-65, not the normal path. lore fetches its own mirrors with each
## repository's read-only deploy key, on demand, before it cuts a base. Use this for
## the window before that key is authorized on the forge — or when the remote is
## reachable from here and not from the service.
##
## REPO is required. Fetching every repository because one was asked for reaches
## remotes nobody named — on a shared host that is someone else's repository being
## touched because you wanted yours refreshed. It also hides a failure: a repo you
## did not ask about reporting FETCH FAILED reads as YOUR command failing.
mirror:
	@test -n "$(REPO)$(ALL)" || { \
		echo "usage: make mirror REPO=<name|url|id>   (or ALL=1 for every repo)"; \
		echo; echo "registered:"; \
		$(COMPOSE) exec -T lore node -e "\
		const {DatabaseSync}=require('node:sqlite'); \
		const d=new DatabaseSync(process.env.LORE_DATA_DIR+'/lore.db'); \
		for (const r of d.prepare('SELECT name, git_url FROM repo').all()) console.log('  '+r.name+'  '+r.git_url);"; \
		exit 1; }
	@$(COMPOSE) exec -T lore node -e "\
	const {DatabaseSync}=require('node:sqlite'); \
	const d=new DatabaseSync(process.env.LORE_DATA_DIR+'/lore.db'); \
	const want=process.argv[1]||''; \
	const rows=d.prepare('SELECT id, name, git_url FROM repo').all() \
	  .filter(r => want==='' || r.id===want || r.name===want || r.git_url.includes(want)); \
	if (rows.length===0) { console.error('no registered repo matches '+JSON.stringify(want)); process.exit(1); } \
	for (const r of rows) console.log(r.id+' '+r.git_url);" "$(REPO)" \
	| tr -d '\r' | while read id url; do \
		b="$(DATA)/repos/$$id/bare.git"; \
		printf '%-48s ' "$$url"; \
		if [ -d "$$b/objects" ]; then \
			git -C "$$b" fetch --prune --tags origin >/dev/null 2>&1 && echo "fetched" || echo "FETCH FAILED"; \
		else \
			mkdir -p "$$(dirname $$b)"; \
			git clone --bare --recurse-submodules "$$url" "$$b" >/dev/null 2>&1 \
				&& git -C "$$b" config remote.origin.fetch '+refs/heads/*:refs/remotes/origin/*' \
				&& git -C "$$b" fetch --prune --tags origin >/dev/null 2>&1 \
				&& echo "cloned" || echo "CLONE FAILED (can you reach it from here, as you?)"; \
		fi; \
	  done

## Replication is always on — this only restarts it.
##
## It used to be opt-in because it needed S3 credentials, and an opt-in backup is
## one that is off. The replica is a local folder now, so there is nothing to
## configure and no reason to gate it.
backup-on:
	$(COMPOSE) up -d litestream
	@echo "replicating to $(BACKUP). Verify with: make backup-check"

## Is the backup real, or just configured? Untested backups are beliefs.
backup-check:
	@n=$$(find "$(BACKUP)" -type f 2>/dev/null | wc -l | tr -d ' '); \
	test "$$n" -gt 0 || { echo "nothing in $(BACKUP) — replication has never written. Is the litestream container up? (make logs)"; exit 1; }; \
	fresh=$$(find "$(BACKUP)" -type f -newermt '-1 hour' 2>/dev/null | wc -l | tr -d ' '); \
	echo "$$n file(s) in $(BACKUP), $$fresh written in the last hour"; \
	test "$$fresh" -gt 0 || { echo "STALE — the replica exists but is not being updated"; exit 1; }
	@echo "This checks the LOCAL half only. Whether an outer script has carried these"
	@echo "files off the machine is not something lore can see, and a copy on this"
	@echo "disk does not survive this disk. 'make backup-drill' proves the restore."

## Prove a restore actually works, on a COPY. Never touches the live database.
##
## "Untested backups are beliefs" is easy to write and easy to leave untested, so it
## is a command. Replicates a consistent snapshot to a throwaway file replica,
## destroys the source the way a dead disk would, restores, and checks the row counts
## and integrity of what comes back.
##
## The snapshot is taken with VACUUM INTO, NOT `cp`. On 2026-08-04 a plain copy of a
## WAL-mode database silently lost 86 knowledge rows and a schema version, because
## the main file does not contain what is still in the WAL — a backup that looks like
## it worked and is missing the newest thing you did.
backup-drill:
	@set -e; D=$$(mktemp -d); trap 'docker rm -f lore-drill-ls >/dev/null 2>&1 || true; rm -rf $$D' EXIT; \
	mkdir -p $$D/db $$D/replica; \
	printf 'dbs:\n  - path: /var/lib/lore/lore.db\n    replicas:\n      - type: file\n        path: /replica/lore\n        sync-interval: 1s\n' > $$D/litestream.yml; \
	$(COMPOSE) exec -T lore node -e "const{DatabaseSync}=require('node:sqlite');new DatabaseSync('$(DATA)/lore.db').exec(\"VACUUM INTO '/tmp/drill.db'\")"; \
	$(COMPOSE) cp lore:/tmp/drill.db $$D/db/lore.db >/dev/null; \
	$(COMPOSE) exec -T lore rm -f /tmp/drill.db; \
	before=$$(docker run --rm --entrypoint node -v $$D/db:/var/lib/lore lore-lore:latest -e "const{DatabaseSync}=require('node:sqlite');const d=new DatabaseSync('/var/lib/lore/lore.db');console.log(['knowledge','finding','verdict','review'].map(t=>t+'='+d.prepare('SELECT count(*) c FROM '+t).get().c).join(' '))"); \
	echo "snapshot: $$before"; \
	docker run --rm -d --name lore-drill-ls -v $$D/db:/var/lib/lore -v $$D/replica:/replica -v $$D/litestream.yml:/etc/litestream.yml:ro litestream/litestream:latest replicate -config /etc/litestream.yml >/dev/null; \
	sleep 6; docker stop lore-drill-ls >/dev/null; \
	rm -f $$D/db/lore.db $$D/db/lore.db-wal $$D/db/lore.db-shm; \
	echo "source destroyed"; \
	docker run --rm -v $$D/db:/var/lib/lore -v $$D/replica:/replica -v $$D/litestream.yml:/etc/litestream.yml:ro litestream/litestream:latest restore -config /etc/litestream.yml /var/lib/lore/lore.db >/dev/null; \
	after=$$(docker run --rm --entrypoint node -v $$D/db:/var/lib/lore lore-lore:latest -e "const{DatabaseSync}=require('node:sqlite');const d=new DatabaseSync('/var/lib/lore/lore.db');const i=d.prepare('PRAGMA integrity_check').get().integrity_check;if(i!=='ok'){console.error('integrity: '+i);process.exit(1)}console.log(['knowledge','finding','verdict','review'].map(t=>t+'='+d.prepare('SELECT count(*) c FROM '+t).get().c).join(' '))"); \
	echo "restored : $$after"; \
	test "$$before" = "$$after" || { echo "DRILL FAILED — the restore does not match the snapshot"; exit 1; }; \
	echo "drill passed: integrity ok and every row came back"

## Restore from backup. Overwrites the live database.
restore:
	@echo "This overwrites $(DATA)/lore.db with the newest replica."
	@printf 'Type RESTORE to confirm: ' && read ans && [ "$$ans" = "RESTORE" ] || { echo "aborted"; exit 1; }
	$(COMPOSE) stop lore
	$(COMPOSE) run --rm litestream restore -o "$(DATA)/lore.db" "$(DATA)/lore.db"
	$(COMPOSE) start lore
	@echo "restored. Verify with: make status"

## Force the retention sweep rather than waiting for the hourly one.
sweep:
	$(COMPOSE) exec -T lore node -e "\
	import('/app/src/ops/retention.ts').then(async m => { \
	  const {Store} = await import('/app/src/store/store.ts'); \
	  const s = new Store('$(DATA)/lore.db'); \
	  console.log(await m.collect(s, {...m.DEFAULT_RETENTION, reposRoot: '$(DATA)/repos'})); \
	  s.close(); });"

shell:
	$(COMPOSE) exec lore sh
