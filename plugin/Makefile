NAME    := oneclaude
VERSION := $(shell sed -n 's/^[[:space:]]*pluginVersion[[:space:]]*= "\(.*\)"/\1/p' main.go)
GO      ?= $(abspath ../.toolchain/go/bin/go)
DIST    := dist
LIB     := $(DIST)/$(NAME)-v$(VERSION).dylib

export GOTOOLCHAIN := local
export CGO_ENABLED := 1
export MACOSX_DEPLOYMENT_TARGET := 12.0

.PHONY: build test vet clean

build: $(LIB)

$(LIB): $(shell find . -name '*.go' -not -path './dist/*') go.mod go.sum
	@mkdir -p $(DIST)
	$(GO) build -trimpath -buildmode=c-shared -ldflags='-s -w' -o $@ .
	@rm -f $(DIST)/*.h

test:
	$(GO) test -race ./...

vet:
	$(GO) vet ./...

clean:
	rm -rf $(DIST)
