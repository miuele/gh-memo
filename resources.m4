m4_dnl --- utlities ---

m4_define([[_DEFINE_ARRAY]], [[m4_ifelse([[$3]], [[]],
	[[m4_define([[$1_LEN]], [[$2]])]],
	[[m4_define([[$1]]_[[$2]], [[$3]]) _DEFINE_ARRAY([[$1]], m4_incr($2), m4_shift(m4_shift(m4_shift($@))))]])]])
m4_define([[DEFINE_ARRAY]], [[_DEFINE_ARRAY([[$1]], 0, m4_shift($@))]])

m4_define([[FOREACH]], [[m4_pushdef([[$1]])_FOREACH(0, $@)m4_popdef([[$1]])]])
m4_define([[_FOREACH]], [[m4_ifelse($1, m4_defn([[$3]]_LEN),
	[[]], [[m4_popdef([[$2]])m4_pushdef([[$2]], m4_defn([[$3]]_[[$1]]))$4[[]]$0(m4_incr($1),m4_shift($@))]])]])

m4_dnl --- resources ---

m4_define([[URL_MARKED_JS]], [[https://cdnjs.cloudflare.com/ajax/libs/marked/16.3.0/lib/marked.umd.min.js]])
m4_define([[SRI_MARKED_JS]], [[sha512-V6rGY7jjOEUc7q5Ews8mMlretz1Vn2wLdMW/qgABLWunzsLfluM0FwHuGjGQ1lc8jO5vGpGIGFE+rTzB+63HdA==]])

m4_define([[URL_DOMPURIFY_JS]], [[https://cdnjs.cloudflare.com/ajax/libs/dompurify/3.2.7/purify.min.js]])
m4_define([[SRI_DOMPURIFY_JS]], [[sha512-78KH17QLT5e55GJqP76vutp1D2iAoy06WcYBXB6iBCsmO6wWzx0Qdg8EDpm8mKXv68BcvHOyeeP4wxAL0twJGQ==]])

m4_define([[URL_KATEX_CSS]], [[https://cdnjs.cloudflare.com/ajax/libs/KaTeX/0.16.9/katex.min.css]])
m4_define([[SRI_KATEX_CSS]], [[sha512-fHwaWebuwA7NSF5Qg/af4UeDx9XqUpYpOGgubo3yWu+b2IQR4UeQwbb42Ti7gVAjNtVoI/I9TEoYeu9omwcC6g==]])
m4_define([[URL_KATEX_JS]], [[https://cdnjs.cloudflare.com/ajax/libs/KaTeX/0.16.9/katex.min.js]])
m4_define([[SRI_KATEX_JS]], [[sha512-LQNxIMR5rXv7o+b1l8+N1EZMfhG7iFZ9HhnbJkTp4zjNr5Wvst75AqUeFDxeRUa7l5vEDyUiAip//r+EFLLCyA==]])

m4_define([[URL_HIGHLIGHT_GITHUB_CSS]], [[https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.11.1/styles/github.min.css]])
m4_define([[SRI_HIGHLIGHT_GITHUB_CSS]], [[sha512-0aPQyyeZrWj9sCA46UlmWgKOP0mUipLQ6OZXu8l4IcAmD2u31EPEy9VcIMvl7SoAaKe8bLXZhYoMaE/in+gcgA==]])

m4_define([[URL_HIGHLIGHT_JS]], [[https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.11.1/highlight.min.js]])
m4_define([[SRI_HIGHLIGHT_JS]], [[sha512-EBLzUL8XLl+va/zAsmXwS7Z2B1F9HUHkZwyS/VKwh3S7T/U0nF4BaU29EP/ZSf6zgiIxYAnKLu6bJ8dqpmX5uw==]])

m4_define([[URL_JSDIFF_JS]], [[https://cdnjs.cloudflare.com/ajax/libs/jsdiff/8.0.2/diff.min.js]])
m4_define([[SRI_JSDIFF_JS]], [[sha512-8pp155siHVmN5FYcqWNSFYn8Efr61/7mfg/F15auw8MCL3kvINbNT7gT8LldYPq3i/GkSADZd4IcUXPBoPP8gA==]])

m4_define([[URL_MARKED_KATEX_EXTENSION_JS]], [[https://cdn.jsdelivr.net/npm/marked-katex-extension@5.1.8/lib/index.umd.min.js]])
m4_define([[SRI_MARKED_KATEX_EXTENSION_JS]], [[sha384-kZc6RA5jLUXlZ3Qx2c6lIk/01XDpL5lC9GwHtLLboKsl0mBL4wQtflWwqQIGEMgq]])

m4_define([[URL_KATEX_FONTS_BASE]], [[https://cdnjs.cloudflare.com/ajax/libs/KaTeX/0.16.9/fonts]])

DEFINE_ARRAY([[URL_KATEX_FONTS_WOFF2]],
	[[KaTeX_AMS-Regular.woff2]],
	[[KaTeX_Caligraphic-Bold.woff2]],
	[[KaTeX_Caligraphic-Regular.woff2]],
	[[KaTeX_Fraktur-Bold.woff2]],
	[[KaTeX_Fraktur-Regular.woff2]],
	[[KaTeX_Main-Bold.woff2]],
	[[KaTeX_Main-BoldItalic.woff2]],
	[[KaTeX_Main-Italic.woff2]],
	[[KaTeX_Main-Regular.woff2]],
	[[KaTeX_Math-BoldItalic.woff2]],
	[[KaTeX_Math-Italic.woff2]],
	[[KaTeX_SansSerif-Bold.woff2]],
	[[KaTeX_SansSerif-Italic.woff2]],
	[[KaTeX_SansSerif-Regular.woff2]],
	[[KaTeX_Script-Regular.woff2]],
	[[KaTeX_Size1-Regular.woff2]],
	[[KaTeX_Size2-Regular.woff2]],
	[[KaTeX_Size3-Regular.woff2]],
	[[KaTeX_Size4-Regular.woff2]],
	[[KaTeX_Typewriter-Regular.woff2]])
