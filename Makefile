DIST_DIR = dist
TARGET = $(DIST_DIR)/index.html
SRC_M4 = index.m4
DIST_MISC = favicon.ico icon.png manifest.json sw.js

SOURCES = $(SRC_M4) styles.css $(shell find core plugins -type f)

.PHONY: all build clean serve

all: build

build: $(TARGET)
$(TARGET): $(SOURCES)
	mkdir -p $(DIST_DIR)
	m4 -P $(SRC_M4) > $(TARGET)
	cp -t $(DIST_DIR) $(DIST_MISC)

# Clean the output directory
clean:
	rm -rf $(DIST_DIR)

# Spin up the Python test server
serve: build
	cd $(DIST_DIR) && python3 -m http.server 8000
