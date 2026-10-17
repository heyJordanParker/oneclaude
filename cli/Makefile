NAME     := oneclaude
VERSION  := $(shell sed -n 's/^[[:space:]]*pluginVersion[[:space:]]*= "\(.*\)"/\1/p' main.go)
GO       ?= go
DIST     := ../.target/dist
LIB      := $(DIST)/$(NAME)-v$(VERSION).dylib
EMBEDDED := cmd/$(NAME)/$(NAME).dylib
RELEASE  := ../.target/release

export CGO_ENABLED := 1

.PHONY: build dist test vet clean

# build writes the routing plugin, the library the proxy loads.
build:
	@mkdir -p $(DIST)
	MACOSX_DEPLOYMENT_TARGET=12.0 $(GO) build -trimpath -buildmode=c-shared -ldflags='-s -w' -o $(LIB) .
	@rm -f $(DIST)/*.h

# dist writes the oneclaude program, which carries the plugin, as
# $(RELEASE)/oneclaude-darwin-arm64, the name cmod publish releases.
dist: $(EMBEDDED)
	@mkdir -p $(RELEASE)
	MACOSX_DEPLOYMENT_TARGET=12.0 GOOS=darwin GOARCH=arm64 $(GO) build -trimpath -ldflags='-s -w -X main.version=$(VERSION)' -o $(RELEASE)/$(NAME)-darwin-arm64 ./cmd/$(NAME)

$(EMBEDDED): build
	cp $(LIB) $@

test: $(EMBEDDED)
	$(GO) test -race ./...

vet: $(EMBEDDED)
	$(GO) vet ./...

clean:
	rm -rf $(DIST) $(RELEASE) $(EMBEDDED)
