NAME     := oneclaude
VERSION  := $(shell sed -n 's/^[[:space:]]*pluginVersion[[:space:]]*= "\(.*\)"/\1/p' main.go)
GO       ?= go
DIST     := ../.target/dist
RELEASE  := ../.target/release
EMBEDDED := cmd/$(NAME)/plugin.lib
HOST     := $(shell $(GO) env GOOS)-$(subst amd64,x64,$(shell $(GO) env GOARCH))

# MACHINES are the machines to build, as cmod names them: cmod publish sets
# CMOD_MACHINES to every machine the mod runs on.
MACHINES ?= $(or $(CMOD_MACHINES),$(HOST))

export CGO_ENABLED := 1
export MACOSX_DEPLOYMENT_TARGET := 13.0

# The routing plugin is a cgo library. clang builds it for macOS, and zig for
# Linux, so one Mac builds every machine.
cc_darwin-arm64 := clang -arch arm64
cc_darwin-x64   := clang -arch x86_64
cc_linux-arm64  := zig cc -target aarch64-linux-gnu
cc_linux-x64    := zig cc -target x86_64-linux-gnu

goos   = $(word 1,$(subst -, ,$(1)))
goarch = $(subst x64,amd64,$(word 2,$(subst -, ,$(1))))
ext    = $(if $(filter darwin,$(call goos,$(1))),dylib,so)
lib    = $(DIST)/$(1)/$(NAME)-v$(VERSION).$(call ext,$(1))

.PHONY: build dist test vet clean FORCE

# build writes the routing plugin for this machine, the library the proxy loads.
build: $(call lib,$(HOST))

$(DIST)/%/$(NAME)-v$(VERSION).dylib $(DIST)/%/$(NAME)-v$(VERSION).so: FORCE
	@mkdir -p $(dir $@)
	GOOS=$(call goos,$*) GOARCH=$(call goarch,$*) CC="$(cc_$*)" $(GO) build -trimpath -buildmode=c-shared -ldflags='-s -w' -o $@ .
	@rm -f $(dir $@)*.h

# dist writes the oneclaude program for each machine, with that machine's
# routing plugin inside it, as $(RELEASE)/oneclaude-<os>-<arch>, the names
# cmod publish releases. It leaves this machine's plugin embedded for test.
dist: $(foreach m,$(MACHINES),$(call lib,$(m)))
	@mkdir -p $(RELEASE)
	@for m in $(MACHINES); do \
		os=$${m%-*}; arch=$$(echo $${m#*-} | sed 's/x64/amd64/'); \
		cp $(DIST)/$$m/$(NAME)-v$(VERSION).* $(EMBEDDED) || exit 1; \
		echo "$(NAME)-$$m"; \
		CGO_ENABLED=0 GOOS=$$os GOARCH=$$arch $(GO) build -trimpath -ldflags='-s -w -X main.version=$(VERSION)' -o $(RELEASE)/$(NAME)-$$m ./cmd/$(NAME) || exit 1; \
	done
	@$(MAKE) --no-print-directory $(EMBEDDED)

$(EMBEDDED): build
	cp $(call lib,$(HOST)) $@

test: $(EMBEDDED)
	$(GO) test -race ./...

vet: $(EMBEDDED)
	$(GO) vet ./...

clean:
	rm -rf $(DIST) $(RELEASE) $(EMBEDDED)
