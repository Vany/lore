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
# WHERE THE DATABASE IS, which since 2026-08-08 is NOT under $(DATA).
#
# It lives in the `lore-db` named volume — ext4 inside the Linux VM — because a host
# bind on Docker Desktop is virtiofs, and SQLite plus unreliable locking plus two
# processes (lore and litestream) is howtocorrupt.html 2.1. Three corruptions in three
# days, the damaged tree being `knowledge` each time.
#
# The path is INSIDE a container and there is deliberately no host-side equivalent. Every
# recipe that reads it either execs into the running service or runs a throwaway
# container against the volume; `db-shell` below is the one place that is written out.
DB      ?= /var/lib/lore/db
# Read the database with no running service — for `make status` and `make db-check`,
# which have to answer WHILE LORE IS DOWN, since that is when the question is asked.
# One process, one connection, gone when it exits.
# compose names a volume `<project>_<name>`, and the project defaults to this directory.
PROJECT ?= $(if $(COMPOSE_PROJECT_NAME),$(COMPOSE_PROJECT_NAME),$(notdir $(CURDIR)))
DBVOL   = $(PROJECT)_lore-db
# compose names the image `<project>-<service>` and the volume `<project>_<name>`, so both
# halves have to follow PROJECT or they describe different deployments — the volume was
# parameterised and the image was not, which is correct only where the project is
# literally `lore`.
# ONE LIST, because two were already wrong: the guard compared nine files and the
# reconciler copied twelve, so tier-config drift never blocked `make up` and
# `sync-deployed` silently overwrote three files the operator was never told differed.
# A guard and its remedy disagreeing about scope is the guard's whole value gone.
DEPLOY_FILES = Makefile docker-compose.yml litestream.yml Dockerfile opencode.Dockerfile \
               sandbox.Dockerfile smoke.mjs mirror-refresh.sh sync-opencode.sh \
               tiers.kimi.json tiers.zai-kimi-openai.json tiers.zai-openai.json
DBIMG   = $(PROJECT)-lore:latest
DBRUN   = docker run --rm -v $(DBVOL):$(DB) -e LORE_DB_DIR=$(DB) --entrypoint node $(DBIMG)
BACKUP  ?= $(shell grep -E '^LORE_HOST_BACKUP=' .env 2>/dev/null | cut -d= -f2)
BACKUP  := $(if $(BACKUP),$(BACKUP),./backup)

# WHICH DEPLOYMENT THIS IS, checked before anything reports on it.
#
# This Makefile lives in the repository AND is copied to the host by `make push`, so
# it can be run from a directory that is not the running deployment — and it was.
# Running it from the checkout's `deploy/` gives compose the project name `deploy`,
# which matches no running container, while DATA falls back to `/var/lib/lore`, which
# holds no database. `make status` then reported, in red:
#
#     service "lore" is not running
#     !! replica: no database at /var/lib/lore/lore.db
#     !! database: service "lore" is not running
#
# — three alarms saying the product had been lost, while every container was up and the
# replica was level. That is the worst thing a status command can do, and it is the
# failure this whole project is about: a command that lies about why it has no status.
#
# So a target that inspects the deployment says plainly when it is pointed at nothing.
# Only for those; `push`, `help` and the build targets are legitimately run from here.
RUNNING_DIR = $(shell docker inspect lore-lore-1 \
                --format '{{index .Config.Labels "com.docker.compose.project.working_dir"}}' 2>/dev/null)
define wrong-directory
	@if [ -n "$(RUNNING_DIR)" ] && [ "$(RUNNING_DIR)" != "$(CURDIR)" ]; then \
	  printf '\033[31mThis is not the running deployment.\033[0m\n'; \
	  printf '  you are here : %s\n' "$(CURDIR)"; \
	  printf '  lore runs in : %s\n' "$(RUNNING_DIR)"; \
	  printf 'Nothing is wrong with the service — this directory has no .env and no data.\n'; \
	  printf 'Run it there:  cd %s && make $@\n' "$(RUNNING_DIR)"; \
	  exit 1; \
	fi
endef

.DEFAULT_GOAL := help
.PHONY: help preflight sync-opencode push build drain drain-off deploy up down down-hard restart logs status status-json status-local doctor new relocate tokens revoke replica-state db-check mirror mirror-daemon mirror-daemon-off mirror-daemon-log backup-on backup-check backup-drill restore sweep shell

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
		     echo "T0's sandbox needs $(DATA) to mean the same thing on both sides, because the"; \
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
	$(wrong-directory)
	@$(COMPOSE) exec -T lore node -e "\
	const {DatabaseSync}=require('node:sqlite'); \
	const d=new DatabaseSync(process.env.LORE_DB_DIR+'/lore.db'); \
	d.prepare(\"INSERT INTO meta(key,value) VALUES('draining','1') ON CONFLICT(key) DO UPDATE SET value='1'\").run();"
	@echo "draining — no new rounds will be claimed. Waiting for work in flight:"
	@waited=0; limit=$${DRAIN_TIMEOUT:-1800}; \
	while :; do \
		out=$$($(COMPOSE) exec -T lore node -e "\
		const {DatabaseSync}=require('node:sqlite'); \
		const d=new DatabaseSync(process.env.LORE_DB_DIR+'/lore.db',{readOnly:true}); \
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
	$(wrong-directory)
	@$(COMPOSE) exec -T lore node -e "\
	const {DatabaseSync}=require('node:sqlite'); \
	const d=new DatabaseSync(process.env.LORE_DB_DIR+'/lore.db'); \
	d.prepare(\"INSERT INTO meta(key,value) VALUES('draining','0') ON CONFLICT(key) DO UPDATE SET value='0'\").run();"
	@echo "draining off — claiming resumed."

## RESTART NOW; THE ROUNDS IN FLIGHT ARE DROPPED AND RE-RUN.
##
## Vany: *"do not queue — just drop sessions and restore after restart."*
##
## This used to drain first: stop claiming, wait for every in-flight round to finish, then
## swap. The argument was model time — an interrupted round is requeued and paid for twice,
## and one morning that cost 109 minutes of t2 work. It is a real cost and it is the
## smaller one.
##
## What draining actually produced, three times in one day: a flag that outlived the deploy
## that set it. A timed-out `make deploy`, a backgrounded one that was interrupted, and one
## I never watched finish — each left `draining=1`, and each time the service answered
## `ok: true` while claiming nothing. Once for thirteen hours, with eight of the team's
## reviews stuck behind it. A queue nobody can see is worse than work that has to run again.
##
## So: restart, and let `reclaimOrphanedJobs` put the interrupted rounds back on the queue
## at startup — it already does, it says how many, and the attempts bound stops a round
## that reliably kills the worker from looping for ever.
##
## `make drain` is still here for a deliberate pause. It is no longer on the path of an
## ordinary deploy, so it can no longer be left set by one that did not finish.
## REFUSES OVER LIVE ROUNDS. Four reviews died in one day to deploys landing while a
## tier was mid-read — each time recorded as somebody else's fault ("socket hang up",
## "opencode is not answering") until the classifier learned better. The operator kept
## having to remember to check the board first; a guard that must be remembered is not a
## guard. FORCE=1 deploys anyway, deliberately, for the case where killing the round is
## the point.
deploy: guard-idle up

## FAILS CLOSED, not open. `catch(e){console.log(0)}` inside the node script and the
## outer `|| echo 0` used to both answer "0 running" for EVERY failure mode — the
## service mid-restart, the db path wrong, node:sqlite unavailable — indistinguishable
## from "checked, and it is genuinely idle". A guard whose failure mode is silent
## permission is not a guard (the 2026-08-06 backup-check incident this team already
## learned from, reproduced here). `-1` is a count no real query can return, so it
## carries "could not look" all the way to the one branch that must never read it as safe.
guard-idle:
	$(wrong-directory)
	@test -n "$(FORCE)" && exit 0; \
	n=$$($(COMPOSE) exec -T lore node -e 'const {DatabaseSync}=require("node:sqlite");try{const d=new DatabaseSync(process.env.LORE_DB_DIR+"/lore.db",{readOnly:true});console.log(d.prepare("SELECT COUNT(*) c FROM job WHERE state = ?").get("running").c)}catch(e){console.log(-1)}' 2>/dev/null || echo -1); \
	if [ "$$n" = "-1" ]; then \
		echo "REFUSING to deploy: could not check whether any round is mid-read — the guard itself could not run."; \
		echo "  See if the lore container is up; if you are certain nothing is running, deploy anyway with:  make deploy FORCE=1"; \
		exit 1; \
	fi; \
	if [ "$$n" != "0" ]; then \
		echo "REFUSING to deploy: $$n round(s) are mid-read right now, and a deploy kills them."; \
		echo "  Wait for the board to go quiet, or deploy anyway with:  make deploy FORCE=1"; \
		exit 1; \
	fi

build: preflight
	@$(STAMP) $(COMPOSE) --profile build-only build

## THE DEPLOYED COPY MUST MATCH THE REPOSITORY'S.
##
## `lore/` is the deployment and is gitignored; `deploy/` is what is tracked. They are
## two copies of one decision, and on 2026-08-08 they had silently diverged in BOTH
## directions: `make knowledge` and `make smoke` existed only in the deployment, and the
## replica-state fix that reads the database's own write log — rather than file mtimes,
## which was the wolf-crying monitor — existed only there too. I then spent an evening
## editing the tracked copy and deploying the other one, and the volume change appeared
## to do nothing at all because compose was reading a file I had not touched.
##
## Worse than wasted time: porting my change onto the stale copy would have REVERTED the
## replica-state fix, silently, in the monitor that exists to avoid crying wolf.
##
## DELETION IS DRIFT TOO. The first version skipped a file the repository no longer has
## (`test -f || continue`), so one removed upstream stayed in force here with the guard
## green — and `sync-deployed` only copied, so the remedy could not answer the guard even
## once it noticed. Both halves handle it now.
##
## Skipped where there is no repository beside the deployment, which is every remote
## host — there `make push` is what keeps them equal, and this has nothing to compare.
define check-deployed
	@test -d ../deploy || exit 0; \
	drift=""; \
	for f in $(DEPLOY_FILES); do \
		if [ ! -f "../deploy/$$f" ]; then \
			test -f "./$$f" && drift="$$drift $$f(deleted-upstream)"; \
			continue; \
		fi; \
		cmp -s "./$$f" "../deploy/$$f" || drift="$$drift $$f"; \
	done; \
	test -z "$$drift" || { \
		echo "REFUSING: the deployment differs from the repository in:$$drift"; \
		echo "  Two copies of one decision, and they have already reverted a fix by drifting."; \
		echo "  Reconcile deliberately — the deployment sometimes holds work the repo lacks:"; \
		echo "      diff ../deploy/<file> ./<file>"; \
		echo "  then \`make sync-deployed\` to take the repository's version."; \
		exit 1; }
endef

## Take the repository's copy, once the diff has been read. Never automatic: the
## deployment has twice held the newer version of a file.
sync-deployed:
	@test -d ../deploy || { echo "no ../deploy beside this deployment — nothing to sync from"; exit 1; }
	@for f in $(DEPLOY_FILES); do \
		if [ -f "../deploy/$$f" ]; then \
			cp "../deploy/$$f" "./$$f" && echo "  $$f"; \
		elif [ -f "./$$f" ]; then \
			rm -f "./$$f" && echo "  $$f (removed: gone from the repository)"; \
		fi; \
	done
	@echo "synced from ../deploy. .env and opencode/ are yours and were not touched."

## THE DATABASE MOVED TO A VOLUME, AND NOBODY ELSE'S HAS.
##
## Before 2026-08-08 `lore.db` lived under $(DATA) on the host bind. The compose change
## points the service at the `lore-db` volume instead — and a volume that does not exist
## yet is created EMPTY, so an existing deployment would come up on a brand new database
## and report zero rules, zero reviews and no tokens. Everything the workgroup taught it,
## apparently gone, with the service answering `ok: true` about it.
##
## I migrated this machine by hand and did not notice the next operator has no path at
## all. So `make up` refuses when the old file is present and the volume is empty, and
## `make migrate-db` is the path — which is `VACUUM INTO`, because a WAL database copied
## with `cp` loses whatever is still in the log.
define check-db-migrated
	@test -f "$(DATA)/lore.db" || exit 0; \
	if docker volume inspect $(DBVOL) >/dev/null 2>&1; then \
		n=$$($(DBRUN) -e "const{existsSync}=require('node:fs');console.log(existsSync(process.env.LORE_DB_DIR+'/lore.db')?1:0)" 2>/dev/null | tr -d '\r'); \
		test "$$n" = "1" && exit 0; \
	fi; \
	echo "REFUSING: $(DATA)/lore.db exists, and the $(DBVOL) volume has no database."; \
	echo "  The database moved to a volume (see spec/deployment.md 4.1). Starting now would"; \
	echo "  come up on an EMPTY one and report no rules, no reviews and no tokens."; \
	echo "      make migrate-db      # VACUUM INTO the volume, then verify"; \
	echo "  The old file is left where it is; delete it yourself once you are satisfied."; \
	exit 1
endef

## Copy an existing host-bind database into the volume. Idempotent: refuses if the volume
## already has one, so it can never overwrite a live database with an older copy.
migrate-db:
	$(wrong-directory)
	@test -f "$(DATA)/lore.db" || { echo "no $(DATA)/lore.db to migrate"; exit 1; }
	@$(COMPOSE) stop lore litestream >/dev/null 2>&1 || true
	@docker volume create $(DBVOL) >/dev/null
	@if $(DBRUN) -e "const{existsSync}=require('node:fs');process.exit(existsSync(process.env.LORE_DB_DIR+'/lore.db')?0:1)" 2>/dev/null; then 		echo "REFUSING: the $(DBVOL) volume already holds a database. Nothing was touched."; exit 1; fi
	@# VACUUM INTO, not cp: a WAL database copied file-by-file loses what is still in the log.
	@sqlite3 "$(DATA)/lore.db" "VACUUM INTO '/tmp/lore-migrate.db'"
	@docker run --rm -v $(DBVOL):$(DB) -v /tmp:/host alpine sh -c 		'cp /host/lore-migrate.db $(DB)/lore.db && chmod 1777 $(DB) && chmod 666 $(DB)/lore.db'
	@rm -f /tmp/lore-migrate.db
	@echo "migrated. Verifying:"
	@$(MAKE) --no-print-directory db-check
	@echo "The old $(DATA)/lore.db is untouched — delete it yourself once you are satisfied."

## Always re-derives the opencode config first: a container running yesterday's
## credentials while the operator has since fixed them is a confusing failure.
up: preflight sync-opencode
	$(check-deployed)
	$(check-db-migrated)
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
	$(wrong-directory)
	$(COMPOSE) logs -f --tail=100

## Provision a repo: a revocable token and the .mcp.json to paste. No key is
## issued — lore does not fetch, `make mirror` does, as you (D-63).
new: preflight
	$(wrong-directory)
	@test -n "$(NAME)" || { echo "usage: make new NAME=<who> GIT=<ssh-url> [URL=<mcp-url>]"; exit 1; }
	@test -n "$(GIT)"  || { echo "usage: make new NAME=<who> GIT=<ssh-url> [URL=<mcp-url>]"; exit 1; }
	$(COMPOSE) exec -T lore node /app/src/index.ts new \
		--name "$(NAME)" --git "$(GIT)" \
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
	$(wrong-directory)
	@test -n "$(REPO)" || { echo "usage: make relocate REPO=<name|url|id> GIT=<new-url>"; exit 1; }
	@test -n "$(GIT)"  || { echo "usage: make relocate REPO=<name|url|id> GIT=<new-url>"; exit 1; }
	@id=$$($(COMPOSE) exec -T lore node -e "\
	const {DatabaseSync}=require('node:sqlite'); \
	const d=new DatabaseSync(process.env.LORE_DB_DIR+'/lore.db'); \
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
	$(COMPOSE) exec -T lore node /app/src/index.ts relocate --repo "$(REPO)" --git "$(GIT)" || exit 1; \
	test -d "$$b/objects" && { git -C "$$b" remote set-url origin "$(GIT)"; echo "mirror origin repointed."; }; \
	echo "next:  make mirror REPO=$(GIT)"

## Check tiers, auth and model ids BEFORE spending a review on them.
doctor:
	$(wrong-directory)
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
	$(wrong-directory)
	@e=/tmp/lore-status.$$$$.err; \
	$(COMPOSE) exec -T lore node /app/src/ops/status.ts $(ID) 2>$$e; rc=$$?; \
	test $$rc -eq 0 || { echo "status could not answer. the error, not a guess:"; head -20 $$e; }; \
	rm -f $$e; \
	state=$$($(MAKE) --no-print-directory replica-state); \
	case "$$state" in \
	  ok*) ;; \
	  *) printf '\033[31m!! replica: %s\033[0m — the knowledge base is the product. make backup-check\n' "$${state#stale }" ;; \
	esac; \
	dbs=$$($(MAKE) --no-print-directory db-check); \
	case "$$dbs" in \
	  ok*) ;; \
	  *) printf '\033[31m!! database: %s\033[0m — a level replica of a damaged file is a copy of the damage\n' "$${dbs#corrupt }" ;; \
	esac; \
	exit $$rc

## The raw JSON, for a script rather than a person.
status-json:
	$(wrong-directory)
	@out=$$(curl -fsS http://127.0.0.1:7777/status 2>&1) \
		&& printf '%s' "$$out" | python3 -m json.tool \
		|| { echo "status-json could not answer. the error, not a guess:"; printf '%s\n' "$$out"; exit 1; }

## Same view, straight against a local database — no container, no service.
## Development on a laptop, where lore runs as plain node and both directories are one.
##
## It set LORE_DATA_DIR alone, which was right while the database lived under it and
## became a path with no database in it the moment the two split — the same failure this
## change fixed for `make status`, one target below it. Both are set, so `dbPath()` and
## the mirror check each get the directory they mean.
status-local:
	@LORE_DATA_DIR=$${LORE_DATA_DIR:-$$PWD/../lore} \
	 LORE_DB_DIR=$${LORE_DB_DIR:-$${LORE_DATA_DIR:-$$PWD/../lore}} \
	 node ../src/ops/status.ts $(ID)

## THE PRODUCT, INSPECTED. What the memory holds, per document, and what the screen
## refused with the reason it gave (D-81).
##
##   make knowledge                     every repository
##   make knowledge REPO=lore           one of them
##   make knowledge REFUSALS=1          and the statements it threw away
##
## The refusal SHARE per document is the reading worth having, and it is not what this
## was built for: rule documents refuse at 0%, and a spec whose share climbs is one
## carrying change-narrative that CLAUDE.md says belongs in MEMO.md. Measured
## 2026-08-07, CLAUDE.md and PROG.md were refused 0 of 13 while every refusal came from
## the explanatory specs — worst in the three edited most that day.
knowledge:
	$(wrong-directory)
	@$(COMPOSE) exec -T lore node /app/src/index.ts knowledge \
		$(if $(REPO),--repo "$(REPO)",) $(if $(REFUSALS),--refusals,)

## DRIVE THE REAL MCP SURFACE, over the wire, as a client (D-76).
##
##   make smoke TOKEN=lore_...      or LORE_TOKEN in the environment
##
## D-76 says a change is validated over MCP and that a CLI run is never evidence the
## product works — and nothing enforced it. This is the cheap half: transport,
## authentication, the tool registry, and that every tool carries a description an agent
## could act on. READ-ONLY by construction — it never starts or polls a review, because
## review_poll consumes deltas (D-78) and a check that damages what it checks is worse
## than none.
##
## The expensive half stays open and stays honest: a fresh session driving a review to
## passed on the tool descriptions alone is Phase 3's real criterion and cannot be a
## script, because what is under test is whether the docs teach an agent nobody briefed.
smoke:
	$(wrong-directory)
	@test -n "$(TOKEN)$(LORE_TOKEN)" || { echo "usage: make smoke TOKEN=<a live token>   (make tokens lists holders)"; exit 2; }
	@LORE_TOKEN="$(or $(TOKEN),$(LORE_TOKEN))" LORE_MCP_URL="$(or $(MCP_URL),http://127.0.0.1:7777/mcp)" \
		node smoke.mjs

## Who holds a token, for which repository, and whether it still works.
##
## Through the CLI rather than an inline SELECT, so the short hash it prints is the
## same string `make revoke` accepts. The hand-rolled query printed a `revoked_at`
## column and there was nothing in the entire system that could set it.
tokens:
	$(wrong-directory)
	@$(COMPOSE) exec -T lore node /app/src/index.ts tokens

## Turn a token off. `make revoke TOKEN=<short>`, from the list above.
##
## By the HASH prefix, not the token: the secret is shown once at provisioning, so an
## operator revoking a leaked or lost one has never had it. Ambiguity is refused
## rather than resolved — picking a winner would lock out a teammate and leave the
## leaked token live.
revoke:
	$(wrong-directory)
	@test -n "$(TOKEN)" || { echo "usage: make revoke TOKEN=<short-hash>   (see: make tokens)"; exit 2; }
	@$(COMPOSE) exec -T lore node /app/src/index.ts revoke --token $(TOKEN)

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
## RESIDENT, NOT A TIMER (D-100).
##
## It used to be a `StartInterval` one-shot: one pass every 300s, then exit. That was
## enough while the only job was keeping mirrors fresh, and it is not enough now that lore
## ASKS for a fetch — a request dropped by a review would have waited up to five minutes
## for the next tick, which is the delay the request exists to remove.
##
## So the loop stays resident: a full pass every INTERVAL, and between passes it answers
## requests within two seconds and stamps a heartbeat. The heartbeat is what lets lore tell
## "fetching" from "nobody is listening" — without it, a review waits its whole timeout for
## a daemon that is not running.
##
## REINSTALL AFTER UPGRADING: an older agent still on a timer never sees a request, and
## lore will say so rather than hanging — but it says it once per review until this is run.
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
		  "    <string>/bin/sh</string><string>$$here/mirror-refresh.sh</string><string>--loop</string>" \
		  '  </array>' \
		  "  <key>WorkingDirectory</key><string>$$here</string>" \
		  '  <key>RunAtLoad</key><true/>' \
		  '  <key>KeepAlive</key><true/>' \
		  "  <key>StandardOutPath</key><string>$$here/mirror.log</string>" \
		  "  <key>StandardErrorPath</key><string>$$here/mirror.log</string>" \
		  '</dict></plist>' > "$$plist"; \
		launchctl bootout gui/$$(id -u)/org.lore.mirror 2>/dev/null || true; \
		launchctl bootstrap gui/$$(id -u) "$$plist" && echo "installed: $$plist"; \
	else \
		mkdir -p "$$HOME/.config/systemd/user"; \
		printf '%s\n' '[Unit]' 'Description=lore mirror refresh' \
		  '[Service]' 'Type=simple' "WorkingDirectory=$$here" 'Restart=always' 'RestartSec=10' \
		  "ExecStart=/bin/sh $$here/mirror-refresh.sh --loop" \
		  '[Install]' 'WantedBy=default.target' \
		  > "$$HOME/.config/systemd/user/lore-mirror.service"; \
		rm -f "$$HOME/.config/systemd/user/lore-mirror.timer"; \
		systemctl --user disable --now lore-mirror.timer 2>/dev/null || true; \
		systemctl --user daemon-reload && systemctl --user enable --now lore-mirror.service \
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
	$(wrong-directory)
	@test -n "$(REPO)$(ALL)" || { \
		echo "usage: make mirror REPO=<name|url|id>   (or ALL=1 for every repo)"; \
		echo; echo "registered:"; \
		$(COMPOSE) exec -T lore node -e "\
		const {DatabaseSync}=require('node:sqlite'); \
		const d=new DatabaseSync(process.env.LORE_DB_DIR+'/lore.db'); \
		for (const r of d.prepare('SELECT name, git_url FROM repo').all()) console.log('  '+r.name+'  '+r.git_url);"; \
		exit 1; }
	@$(COMPOSE) exec -T lore node -e "\
	const {DatabaseSync}=require('node:sqlite'); \
	const d=new DatabaseSync(process.env.LORE_DB_DIR+'/lore.db'); \
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
## WHAT THE DATABASE ITSELF SAYS IT LAST WROTE, not when its files were touched.
##
## SQLite touches lore.db-wal on open and on checkpoint, not only on commit, so a
## restart moved it with no transaction behind it — and this printed "14m behind" while
## litestream's own log said txid.replica == txid.db on the same second, during the
## twenty minutes the DATABASE was in fact unreadable. A monitor that cries wolf does
## not merely get muted; it points at the wrong thing.
##
## ZERO MEANS DIFFERENT THINGS ON THE TWO PATHS, so only one of them may say it. Asking
## the service, 0 is "no row carried a timestamp" — the database exists and nothing has
## been written. Asking the filesystem, 0 is `statSync` throwing for BOTH files — there is
## no database at all. The fallback says `none` for that, so the two answers cannot be
## read as each other.
##
## A DATABASE NOBODY HAS WRITTEN TO YET IS LEVEL, NOT MISSING. `lastWriteAt` answers
## `undefined` there and the heartbeat reports `level`; this printed a red "no database in
## the volume" for the same state, so the two monitors disagreed about a fresh install and
## the one a person runs was the alarming one. Empty output means the read FAILED, which
## is a different thing again and says so.
##
## Asked through the running service, because that is the coherent reader of a WAL
## database. With the service DOWN there is nobody to ask, so it falls back to file times
## in a throwaway container against the volume AND SAYS WHICH IT USED — answering while
## lore is down is the whole reason this exists in shell rather than as a call into the
## process.
replica-state:
	$(wrong-directory)
	@n=$$(find "$(BACKUP)" -type f -name '*.ltx' 2>/dev/null | wc -l | tr -d ' '); \
	test "$$n" -gt 0 || { echo "stale nothing in $(BACKUP) — replication has never written"; exit 0; }; \
	dbt=$$($(COMPOSE) exec -T lore node -e "\
	  const {DatabaseSync}=require('node:sqlite'); \
	  const d=new DatabaseSync(process.env.LORE_DB_DIR+'/lore.db',{readOnly:true}); \
	  const r=d.prepare(\"SELECT MAX(t) t FROM (SELECT MAX(updated_at) t FROM review UNION ALL SELECT MAX(updated_at) FROM job UNION ALL SELECT MAX(verified_at) FROM knowledge UNION ALL SELECT MAX(retired_at) FROM knowledge UNION ALL SELECT MAX(at) FROM usage UNION ALL SELECT MAX(first_seen) FROM finding UNION ALL SELECT MAX(delivered_at) FROM finding UNION ALL SELECT MAX(created_at) FROM verdict UNION ALL SELECT MAX(created_at) FROM token UNION ALL SELECT MAX(revoked_at) FROM token UNION ALL SELECT MAX(created_at) FROM knowledge_conflict UNION ALL SELECT MAX(resolved_at) FROM knowledge_conflict UNION ALL SELECT MAX(accepted_at) FROM suppression UNION ALL SELECT MAX(started_at) FROM tier_run UNION ALL SELECT MAX(created_at) FROM repo)\").get(); \
	  console.log(r && r.t ? Math.floor(Date.parse(r.t)/1000) : 0);" 2>/dev/null | tr -d '\r'); \
	if [ -z "$$dbt" ]; then \
		dbt=$$($(DBRUN) -e "const{statSync}=require('node:fs');\
		  const t=['/lore.db','/lore.db-wal'].map(f=>{try{return Math.floor(statSync(process.env.LORE_DB_DIR+f).mtimeMs/1000)}catch{return 0}}); \
		  console.log(Math.max(...t) || 'none');" 2>/dev/null | tr -d '\r'); \
		how=" (from file times: the service is down, so its own write log is unreadable)"; \
	fi; \
	test -n "$$dbt" || { echo "stale could not read the database in the $(DBVOL) volume"; exit 0; }; \
	test "$$dbt" != "none" || { echo "stale no database in the $(DBVOL) volume"; exit 0; }; \
	test "$$dbt" != "0" || { echo "ok replica is level — the database exists and nothing has ever been written to it"; exit 0; }; \
	rept=$$(find "$(BACKUP)" -type f -name '*.ltx' -exec sh -c 'date -r "$$1" +%s 2>/dev/null || stat -c %Y "$$1"' _ {} \; | sort -n | tail -1); \
	behind=$$((dbt - rept)); \
	if [ "$$behind" -gt 300 ]; then \
		echo "stale the database has changed but the replica has not, for $$((behind / 60))m$$how"; \
	else \
		echo "ok replica is level with the database ($$n segments, $$behind s behind)$$how"; \
	fi

## Is the DATABASE readable? Replicating a corrupted file faithfully is not a backup.
##
## Prints "ok" or "corrupt <detail>". Separate from replica-state because the two
## answer different questions and the failure that motivated it makes them look alike:
## for a whole period every table returned `database disk image is malformed` while
## backup-check reported healthy, because it only ever compared timestamps. A replica
## that is perfectly level with an unreadable database is a faithful copy of nothing.
##
## Through a THROWAWAY container, not `compose exec`: this has to answer while lore is
## down, which is precisely when somebody asks it — a crash-looping service could not
## exec, so the check that says "your database is unreadable" was itself unreachable in
## the one state it exists for.
##
## Never from the host. The database is in a volume now and has no host path at all; even
## when it had one, WAL over a Docker Desktop bind did not coordinate with a host
## sqlite3, and reading it from outside produced SQLITE_IOERR_SHORT_READ inside the
## running service.
db-check:
	$(wrong-directory)
	@out=$$($(DBRUN) -e "\
	const {DatabaseSync}=require('node:sqlite'); \
	try { \
	  const d=new DatabaseSync(process.env.LORE_DB_DIR + '/lore.db', {readOnly:true}); \
	  const r=d.prepare('PRAGMA integrity_check').get(); \
	  console.log(Object.values(r)[0]); \
	} catch (e) { console.log('unreadable: ' + e.message); }" 2>&1 | tr -d '\r'); \
	case "$$out" in \
	  ok) echo "ok database passes integrity_check" ;; \
	  *) echo "corrupt $$out" ;; \
	esac

backup-check:
	$(wrong-directory)
	@state=$$($(MAKE) --no-print-directory db-check); \
	echo "$$state"; \
	case "$$state" in ok*) ;; *) \
	  echo "The database itself is damaged. A replica of it is a faithful copy of the damage,"; \
	  echo "so RESTORE FROM AN EARLIER GENERATION rather than trusting the newest — see make restore."; \
	  exit 1 ;; \
	esac
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
	$(wrong-directory)
	@set -e; D=$$(mktemp -d); trap 'docker rm -f lore-drill-ls >/dev/null 2>&1 || true; rm -rf $$D' EXIT; \
	mkdir -p $$D/db $$D/replica; \
	printf 'dbs:\n  - path: /var/lib/lore/lore.db\n    replicas:\n      - type: file\n        path: /replica/lore\n        sync-interval: 1s\n' > $$D/litestream.yml; \
	$(COMPOSE) exec -T lore node -e "const{DatabaseSync}=require('node:sqlite');new DatabaseSync(process.env.LORE_DB_DIR+'/lore.db').exec(\"VACUUM INTO '/tmp/drill.db'\")"; \
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
	@echo "This overwrites the database in the $(DBVOL) volume with the newest replica."
	@printf 'Type RESTORE to confirm: ' && read ans && [ "$$ans" = "RESTORE" ] || { echo "aborted"; exit 1; }
	$(COMPOSE) stop lore
	$(COMPOSE) run --rm --no-deps litestream restore -o "$(DB)/lore.db" "$(DB)/lore.db"
	$(COMPOSE) start lore
	@echo "restored. Verify with: make status"

## Force the retention sweep rather than waiting for the hourly one.
sweep:
	$(wrong-directory)
	$(COMPOSE) exec -T lore node -e "\
	import('/app/src/ops/retention.ts').then(async m => { \
	  const {Store} = await import('/app/src/store/store.ts'); \
	  const s = new Store(process.env.LORE_DB_DIR + '/lore.db'); \
	  console.log(await m.collect(s, {...m.DEFAULT_RETENTION, reposRoot: '$(DATA)/repos'})); \
	  s.close(); });"

shell:
	$(wrong-directory)
	$(COMPOSE) exec lore sh
