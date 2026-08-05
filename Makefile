# Docker configuration (override via environment: DOCKER_REGISTRY, DOCKER_TAG)
IMAGE_NAME := hathor-integration-test-helper
# Deliberately no default. Releases are published by
# .github/workflows/docker.yml, which builds multi-arch, verifies the tag
# against package.json, and refuses to overwrite a published version. This
# Makefile does none of that: it builds single-arch and pushes whatever it
# has. Defaulting to the real namespace would make `make push` a one-word
# way to clobber a published multi-arch image and move `:latest`, bypassing
# every guard. Set DOCKER_REGISTRY explicitly to push to a scratch registry.
REGISTRY := $(DOCKER_REGISTRY)
# package.json is the source of truth for the version, so a local build
# carries the same tag the publish workflow would produce for this commit.
# Override with DOCKER_TAG for throwaway builds.
VERSION := $(shell bun --print "require('./package.json').version" 2>/dev/null)
TAG := $(or $(DOCKER_TAG),$(VERSION),latest)

# Help target (default)
.PHONY: help
help:
	@echo "Docker commands:"
	@echo "  make build      - Build Docker image"
	@echo "  make push       - Push to a scratch registry (needs DOCKER_REGISTRY)"
	@echo "  make run        - Run container locally"
	@echo "  make clean      - Remove local images"
	@echo ""
	@echo "Variables:"
	@echo "  REGISTRY=$(REGISTRY)"
	@echo "  TAG=$(TAG)"

.PHONY: build
build:
	docker build -t $(IMAGE_NAME):$(TAG) -t $(IMAGE_NAME):latest .

# Checked in the recipe, not with `ifndef`: make evaluates conditionals at
# parse time, so a top-level $(error) would fire on `make build` too.
# `:latest` is intentionally not pushed here — the release workflow owns it.
# Not `push: build` — a prerequisite would run the whole image build before
# the guard could reject the push. Check first, then build.
.PHONY: push
push:
	@test -n "$(REGISTRY)" || { \
		echo "DOCKER_REGISTRY is unset."; \
		echo "Releases are published by .github/workflows/docker.yml, which"; \
		echo "requires a signed annotated tag on a signed commit — see the"; \
		echo "Releases section of CLAUDE.md."; \
		echo "Set DOCKER_REGISTRY to push a scratch image somewhere else."; \
		exit 1; \
	}
	@test "$(TAG)" != "latest" || { \
		echo "TAG resolved to 'latest', which this target refuses to push."; \
		echo "That happens when DOCKER_TAG is unset and the version could not"; \
		echo "be read from package.json — pushing would move a floating tag"; \
		echo "rather than an identifiable build. Set DOCKER_TAG explicitly."; \
		exit 1; \
	}
	$(MAKE) build
	docker tag $(IMAGE_NAME):$(TAG) $(REGISTRY)/$(IMAGE_NAME):$(TAG)
	docker push $(REGISTRY)/$(IMAGE_NAME):$(TAG)

.PHONY: run
run:
	docker run --rm -p 3020:3020 \
		--env-file .env \
		$(IMAGE_NAME):latest

.PHONY: clean
clean:
	docker rmi $(IMAGE_NAME):$(TAG) $(IMAGE_NAME):latest 2>/dev/null || true
