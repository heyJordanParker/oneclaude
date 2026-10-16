NAME    := oneclaude
VERSION := $(shell sed -n 's/^[[:space:]]*pluginVersion[[:space:]]*= "\(.*\)"/\1/p' main.go)
GO      ?= $(abspath ../.target/toolchain/go/bin/go)
DIST    := ../.target/dist
LIB     := $(DIST)/$(NAME)-v$(VERSION).dylib
BIN     ?= ../.target/bin

export GOTOOLCHAIN := local
export CGO_ENABLED := 1

.PHONY: build installer test vet clean

build: $(LIB)

installer:
	@mkdir -p $(BIN)
	$(GO) build -trimpath -o $(BIN)/oneclaude-install ./cmd/install

$(LIB): $(shell find . -name '*.go' -o -name '*.html') go.mod go.sum
	@mkdir -p $(DIST)
	MACOSX_DEPLOYMENT_TARGET=12.0 $(GO) build -trimpath -buildmode=c-shared -ldflags='-s -w' -o $@ .
	@rm -f $(DIST)/*.h

test:
	$(GO) test -race ./...

vet:
	$(GO) vet ./...

clean:
	rm -rf $(DIST)
