DIST_DIR = dist
BUILD_DIR = build
TARGET = $(DIST_DIR)/index.html
SW = $(DIST_DIR)/sw.js
DIST_MISC = favicon.ico icon.png manifest.json

# Build stamp, shown in Settings and used as the service worker's cache name,
# so every build reaches installed copies. BUILD_TIME can be overridden
# (make BUILD_TIME=2026-01-01T00:00:00Z) for a reproducible build.
BUILD_TIME := $(shell date -u +%Y-%m-%dT%H:%M:%SZ)
BUILD_COMMIT := $(shell git rev-parse --short HEAD 2>/dev/null)$(if $(shell git status --porcelain 2>/dev/null),-dirty)
BUILD_ID := $(subst :,,$(subst -,,$(BUILD_TIME)))$(if $(BUILD_COMMIT),-$(BUILD_COMMIT))
BUILD_DEFS = -DBUILD_TIME='$(BUILD_TIME)' -DBUILD_COMMIT='$(BUILD_COMMIT)' -DBUILD_ID='$(BUILD_ID)'

# Every module, in a stable order. The order does not matter at runtime:
# define() only registers, and modules are instantiated on first require.
JS_SOURCES = src/define.js $(BUILD_DIR)/resources.js $(BUILD_DIR)/buildInfo.js $(sort $(shell find src -name '*.js' ! -name define.js))
SCRIPTS = $(BUILD_DIR)/scripts.html

.PHONY: all build clean serve test check FORCE

all: build

build: $(TARGET) $(SW)
	cp $(DIST_MISC) $(DIST_DIR)/

$(BUILD_DIR)/resources.js: resources.js.m4 resources.m4
	mkdir -p $(BUILD_DIR)
	m4 -P resources.js.m4 > $@

# Rewritten on every make: each build gets its own stamp.
$(BUILD_DIR)/buildInfo.js: buildInfo.js.m4 FORCE
	mkdir -p $(BUILD_DIR)
	m4 -P $(BUILD_DEFS) buildInfo.js.m4 > $@

# One inline <script> per module, tagged with //# sourceURL so DevTools and
# stack traces show the original file name.
$(SCRIPTS): $(JS_SOURCES)
	mkdir -p $(BUILD_DIR)
	for f in $(JS_SOURCES); do \
		printf '<script>\n'; cat "$$f"; printf '//# sourceURL=%s\n</script>\n' "$$f"; \
	done > $@

$(TARGET): index.m4 styles.css $(SCRIPTS)
	mkdir -p $(DIST_DIR)
	m4 -P index.m4 > $@
	@! grep -nE '\b(URL|SRI|BUILD)_[A-Z_]+\b|m4_[a-z]+' $@ || (echo "error: unexpanded m4 macro in $@" >&2; false)

$(SW): sw.js.m4 resources.m4 FORCE
	mkdir -p $(DIST_DIR)
	m4 -P $(BUILD_DEFS) sw.js.m4 > $@
	@! grep -nE '\b(URL|SRI|BUILD)_[A-Z_]+\b|m4_[a-z]+' $@ || (echo "error: unexpanded m4 macro in $@" >&2; false)

# Unit tests (Node's built-in runner; no packages needed)
test: $(BUILD_DIR)/resources.js $(BUILD_DIR)/buildInfo.js
	node --test tests/*.test.mjs

# Syntax-check every module (needs Node)
check: $(JS_SOURCES)
	for f in $(JS_SOURCES); do node --check "$$f" || exit 1; done

clean:
	rm -rf $(DIST_DIR) $(BUILD_DIR)

# Spin up the Python test server
serve: build
	cd $(DIST_DIR) && python3 -m http.server 8000
