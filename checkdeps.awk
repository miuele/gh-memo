# Fails the build when a module depends on one that is not built in, such as
# a helper of a plugin left out of PLUGINS. Reads every module file and
# collects each define('name', [deps], ...) header, which may span lines.
#
#   awk -f checkdeps.awk src/define.js build/... src/...
FNR == 1 { header = "" }
/^define\('/ { header = " " }
header != "" && !done[FILENAME] {
	header = header $0
	if (index(header, "]")) {
		done[FILENAME] = 1
		split(header, quoted, "'")
		defined[quoted[2]] = 1
		deps = substr(header, index(header, "[") + 1)
		deps = substr(deps, 1, index(deps, "]") - 1)
		n = split(deps, parts, "'")
		for (i = 2; i <= n; i += 2) needs[quoted[2] SUBSEP parts[i]] = FILENAME
		header = ""
	}
}
END {
	for (key in needs) {
		split(key, pair, SUBSEP)
		if (!(pair[2] in defined)) {
			printf "error: %s (%s) needs %s, which is not built in\n", pair[1], needs[key], pair[2] > "/dev/stderr"
			bad = 1
		}
	}
	exit bad
}
