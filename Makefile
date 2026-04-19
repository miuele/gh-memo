DIST_DIR = dist
TARGET = $(DIST_DIR)/index.html
SRC_M4 = index.m4
SW_M4 = sw.js.m4
DIST_MISC = favicon.ico icon.png manifest.json

SOURCES = $(SRC_M4) $(SW_M4) resources.m4 styles.css $(shell find core plugins -type f)

.PHONY: all build clean serve

all: build

build: $(TARGET)
$(TARGET): $(SOURCES)
	mkdir -p $(DIST_DIR)
	m4 -P $(SRC_M4) > $(TARGET)
	m4 -P $(SW_M4) > $(DIST_DIR)/sw.js
	cp -t $(DIST_DIR) $(DIST_MISC)

# Clean the output directory
clean:
	rm -rf $(DIST_DIR)

# Spin up the Python test server
serve: build
	cd $(DIST_DIR) && python3 -m http.server 8000
