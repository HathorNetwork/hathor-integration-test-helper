# Docker configuration (override via environment: DOCKER_REGISTRY, DOCKER_TAG)
IMAGE_NAME := hathor-integration-test-helper
REGISTRY := $(or $(DOCKER_REGISTRY),docker.io/hathor)
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
	@echo "  make push       - Push image to registry"
	@echo "  make run        - Run container locally"
	@echo "  make clean      - Remove local images"
	@echo ""
	@echo "Variables:"
	@echo "  REGISTRY=$(REGISTRY)"
	@echo "  TAG=$(TAG)"

.PHONY: build
build:
	docker build -t $(IMAGE_NAME):$(TAG) -t $(IMAGE_NAME):latest .

.PHONY: push
push: build
	docker tag $(IMAGE_NAME):$(TAG) $(REGISTRY)/$(IMAGE_NAME):$(TAG)
	docker tag $(IMAGE_NAME):latest $(REGISTRY)/$(IMAGE_NAME):latest
	docker push $(REGISTRY)/$(IMAGE_NAME):$(TAG)
	docker push $(REGISTRY)/$(IMAGE_NAME):latest

.PHONY: run
run:
	docker run --rm -p 3020:3020 \
		--env-file .env \
		$(IMAGE_NAME):latest

.PHONY: clean
clean:
	docker rmi $(IMAGE_NAME):$(TAG) $(IMAGE_NAME):latest 2>/dev/null || true
