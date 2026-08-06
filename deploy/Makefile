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
.PHONY: help preflight sync-opencode push build drain drain-off deploy up down down-hard restart logs status status-json status-local doctor new relocate tokens replica-state mirror mirror-daemon mirror-daemon-off mirror-daemon-log backup-on backup-check backup-drill restore sweep shell

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

## Stamped with the commit being built, so `/status` can report what is running
## rather than leaving everyone to assume it is current.
STAMP = LORE_COMMIT="$$(git -C .. rev-parse --short HEAD 2>/dev/null || echo unknown)$$(git -C .. diff --quiet 2>/dev/null || echo -dirty)" \
        LORE_BUILT_AT="$$(date -u +%Y-%m-%dT%H:%M:%SZ)"

## Stop taking new rounds, let the ones in flight finish, then deploy (D-72).
##
##   make deploy               drain, wait, rebuild, start
##   make drain                just drain and wait
##   make drain-off            change your mind
##
## A restart loses no state — it is all in SQLite — but it throws away MODEL TIME:
## an interrupted round is requeued and runs again from scratch, paid for twice. One
## morning that cost 109 minutes of t2 work.
##
## MCP keeps serving throughout. Clients poll, submit and start reviews as normal;
## new work simply queues and the next container runs it. Nobody sees an error.
##
## The flag does not survive the restart it was for: the starting process clears it,
## so a forgotten drain cannot leave a service that answers ok while doing nothing.
drain:
	@$(COMPOSE) exec -T lore node -e "\
	const {DatabaseSync}=require('node:sqlite'); \
	const d=new DatabaseSync(process.env.LORE_DATA_DIR+'/lore.db'); \
	d.prepare(\"INSERT INTO meta(key,value) VALUES('draining','1') ON CONFLICT(key) DO UPDATE SET value='1'\").run();"
	@echo "draining — no new rounds will be claimed. Waiting for work in flight:"
	@waited=0; limit=$${DRAIN_TIMEOUT:-1800}; \
	while :; do \
		out=$$($(COMPOSE) exec -T lore node -e "\
		const {DatabaseSync}=require('node:sqlite'); \
		const d=new DatabaseSync(process.env.LORE_DATA_DIR+'/lore.db',{readOnly:true}); \
		const rows=d.prepare(\"SELECT j.review_id id, r.branch b, j.updated_at u FROM job j JOIN review r ON r.id=j.review_id WHERE j.state='running'\").all(); \
		for (const x of rows) console.log('  '+x.id.slice(4,16)+'  '+x.b.slice(0,38)+'  '+Math.round((Date.now()-Date.parse(x.u))/1000)+'s'); \
		console.log('COUNT '+rows.length);"); \
		n=$$(printf '%s' "$$out" | sed -n 's/^COUNT //p'); \
		printf '%s' "$$out" | grep -v '^COUNT ' || true; \
		test "$$n" = "0" && { echo "  drained — nothing in flight."; break; }; \
		test "$$waited" -ge "$$limit" && { \
			echo; \
			echo "STILL RUNNING after $$limit s. Nothing was killed and nothing is lost."; \
			echo "A deep tier can legitimately take 20 minutes; a stuck one never finishes."; \
			echo "Decide: wait longer (make drain DRAIN_TIMEOUT=3600), or accept the loss"; \
			echo "and run 'make up' — the round will be requeued and re-run from scratch."; \
			exit 1; }; \
		sleep 10; waited=$$((waited + 10)); \
	done

drain-off:
	@$(COMPOSE) exec -T lore node -e "\
	const {DatabaseSync}=require('node:sqlite'); \
	const d=new DatabaseSync(process.env.LORE_DATA_DIR+'/lore.db'); \
	d.prepare(\"INSERT INTO meta(key,value) VALUES('draining','0') ON CONFLICT(key) DO UPDATE SET value='0'\").run();"
	@echo "draining off — claiming resumed."

## The deploy you actually want: nothing in flight is thrown away.
deploy: drain up

build: preflight
	@$(STAMP) $(COMPOSE) --profile build-only build

## Always re-derives the opencode config first: a container running yesterday's
## credentials while the operator has since fixed them is a confusing failure.
up: preflight sync-opencode
	@$(STAMP) $(COMPOSE) --profile build-only build sandbox
	@$(STAMP) $(COMPOSE) up -d --build
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
	state=$$($(MAKE) --no-print-directory replica-state); \
	case "$$state" in \
	  ok*) ;; \
	  *) printf '\033[31m!! replica: %s\033[0m — the knowledge base is the product. make backup-check\n' "$${state#stale }" ;; \
	esac; \
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

## Keep every mirror fresh, forever, without anyone remembering to.
##
##   make mirror-daemon        install and start it
##   make mirror-daemon-off    stop and remove it
##   make mirror-daemon-log    what it has been doing
##
## Refreshing the mirror is the SERVICE's responsibility, not the client's: the
## client is an agent, usually on another machine, with no shell here. And it is not
## a person's, because a person who has to remember is a person who forgets — on
## 2026-08-05 a forgotten refresh failed more reviews than every model and transport
## fault combined.
##
## It runs OUTSIDE docker, as you, using the ssh credentials this host already has.
## That is the whole reason it needs no key of its own.
##
## macOS: a LaunchAgent in your login session, which is what makes the keychain
## available — a passphrase-protected key works here and would NOT in a system-wide
## daemon. Linux: a systemd --user timer, which needs `loginctl enable-linger $(USER)`
## to run while you are logged out, and a key the agent does not have to unlock.
mirror-daemon:
	@here="$$(cd $$(dirname $(firstword $(MAKEFILE_LIST))) && pwd)"; \
	if [ "$$(uname)" = "Darwin" ]; then \
		plist="$$HOME/Library/LaunchAgents/org.lore.mirror.plist"; \
		mkdir -p "$$HOME/Library/LaunchAgents"; \
		printf '%s\n' \
		  '<?xml version="1.0" encoding="UTF-8"?>' \
		  '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">' \
		  '<plist version="1.0"><dict>' \
		  '  <key>Label</key><string>org.lore.mirror</string>' \
		  '  <key>ProgramArguments</key><array>' \
		  "    <string>/bin/sh</string><string>$$here/mirror-refresh.sh</string>" \
		  '  </array>' \
		  "  <key>WorkingDirectory</key><string>$$here</string>" \
		  '  <key>StartInterval</key><integer>$(or $(INTERVAL),300)</integer>' \
		  '  <key>RunAtLoad</key><true/>' \
		  "  <key>StandardOutPath</key><string>$$here/mirror.log</string>" \
		  "  <key>StandardErrorPath</key><string>$$here/mirror.log</string>" \
		  '</dict></plist>' > "$$plist"; \
		launchctl bootout gui/$$(id -u)/org.lore.mirror 2>/dev/null || true; \
		launchctl bootstrap gui/$$(id -u) "$$plist" && echo "installed: $$plist"; \
	else \
		mkdir -p "$$HOME/.config/systemd/user"; \
		printf '%s\n' '[Unit]' 'Description=lore mirror refresh' \
		  '[Service]' 'Type=oneshot' "WorkingDirectory=$$here" \
		  "ExecStart=/bin/sh $$here/mirror-refresh.sh" \
		  > "$$HOME/.config/systemd/user/lore-mirror.service"; \
		printf '%s\n' '[Unit]' 'Description=lore mirror refresh' \
		  '[Timer]' 'OnBootSec=1min' 'OnUnitActiveSec=$(or $(INTERVAL),300)' \
		  '[Install]' 'WantedBy=timers.target' \
		  > "$$HOME/.config/systemd/user/lore-mirror.timer"; \
		systemctl --user daemon-reload && systemctl --user enable --now lore-mirror.timer \
		  && echo "installed. For it to run while logged out:  loginctl enable-linger $$USER"; \
	fi
	@echo "checking it actually works, rather than assuming:"
	@sh ./mirror-refresh.sh

mirror-daemon-off:
	@if [ "$$(uname)" = "Darwin" ]; then \
		launchctl bootout gui/$$(id -u)/org.lore.mirror 2>/dev/null; \
		rm -f "$$HOME/Library/LaunchAgents/org.lore.mirror.plist"; \
	else \
		systemctl --user disable --now lore-mirror.timer 2>/dev/null; \
		rm -f "$$HOME/.config/systemd/user/lore-mirror."*; systemctl --user daemon-reload; \
	fi
	@echo "removed. Mirrors will go stale, and lore refuses a review rather than using one."

mirror-daemon-log:
	@if [ "$$(uname)" = "Darwin" ]; then tail -40 ./mirror.log 2>/dev/null || echo "nothing logged yet"; \
	else journalctl --user -u lore-mirror.service -n 40 --no-pager; fi

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
## Is the replica caught up with the database?
##
## Prints "ok <detail>" or "stale <detail>". Exit status is not used, so both callers
## can decide for themselves what to do about it.
##
## THE QUESTION IS NOT "WAS A FILE WRITTEN RECENTLY".
##
## It was, and it cried wolf the first time it mattered. litestream writes only when
## there is something to replicate, so an IDLE database produces no new files — which
## is the healthy state, and is exactly what "nothing written in an hour" also looks
## like when replication has died. Measured while checking it: the newest replica file
## and the last write to lore.db carried the same timestamp to the second, and the
## monitor called that STALE.
##
## A monitor that cries wolf gets ignored, and this one guards the product. So it
## compares the replica against the DATABASE: caught up is fine at any age, and behind
## is a problem however recent the files are.
replica-state:
	@db="$(DATA)/lore.db"; \
	test -f "$$db" || { echo "stale no database at $$db"; exit 0; }; \
	n=$$(find "$(BACKUP)" -type f -name '*.ltx' 2>/dev/null | wc -l | tr -d ' '); \
	test "$$n" -gt 0 || { echo "stale nothing in $(BACKUP) — replication has never written"; exit 0; }; \
	dbt=$$(date -r "$$db" +%s 2>/dev/null || stat -c %Y "$$db"); \
	rept=$$(find "$(BACKUP)" -type f -name '*.ltx' -exec sh -c 'date -r "$$1" +%s 2>/dev/null || stat -c %Y "$$1"' _ {} \; | sort -n | tail -1); \
	behind=$$((dbt - rept)); \
	if [ "$$behind" -gt 300 ]; then \
		echo "stale the database has changed but the replica has not, for $$((behind / 60))m"; \
	else \
		echo "ok replica is level with the database ($$n segments, $$behind s behind)"; \
	fi

backup-check:
	@state=$$($(MAKE) --no-print-directory replica-state); \
	echo "$$state"; \
	case "$$state" in ok*) ;; *) echo "Is the litestream container up? (make logs)"; exit 1 ;; esac
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
