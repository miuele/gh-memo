DIST_DIR = dist
BUILD_DIR = build
TARGET = $(DIST_DIR)/index.html
SW = $(DIST_DIR)/sw.js
DIST_MISC = favicon.ico icon.png manifest.json

# Every module, in a stable order. The order does not matter at runtime:
# define() only registers, and modules are instantiated on first require.
JS_SOURCES = src/define.js $(BUILD_DIR)/resources.js $(sort $(shell find src -name '*.js' ! -name define.js))
SCRIPTS = $(BUILD_DIR)/scripts.html

.PHONY: all build clean serve test check

all: build

build: $(TARGET) $(SW)
	cp $(DIST_MISC) $(DIST_DIR)/

$(BUILD_DIR)/resources.js: resources.js.m4 resources.m4
	mkdir -p $(BUILD_DIR)
	m4 -P resources.js.m4 > $@

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
	@! grep -nE '\b(URL|SRI)_[A-Z_]+\b|m4_[a-z]+' $@ || (echo "error: unexpanded m4 macro in $@" >&2; false)

$(SW): sw.js.m4 resources.m4
	mkdir -p $(DIST_DIR)
	m4 -P sw.js.m4 > $@

# Unit tests (Node's built-in runner; no packages needed)
test: $(BUILD_DIR)/resources.js
	node --test tests/*.test.mjs

# Syntax-check every module (needs Node)
check: $(JS_SOURCES)
	for f in $(JS_SOURCES); do node --check "$$f" || exit 1; done

clean:
	rm -rf $(DIST_DIR) $(BUILD_DIR)

# Spin up the Python test server
serve: build
	cd $(DIST_DIR) && python3 -m http.server 8000
