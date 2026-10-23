![a](img/a.png) and ![b](<my pic.png> "t") and ![c](my%20pic2.png 'x')
![nested [x]](n.png) ![paren](p(1).png) ![esc](e\_x.png) ![ext](https://x.org/a.png)
![ref][R1] and ![R2][] and ![R3], ![missing][nope]

[r1]: ref1.png
[R2]: <ref 2.png>
[r3]: ref3.png "t"
[unused]: unused.png

<img src="html.png" alt="h"> <img alt='x' src='a&amp;b.png'>

Code: `![code](code.png)` and ``x ![code2](code2.png) ` y``.

```md
![fenced](fenced.png)
```
~~~
![tilde](tilde.png)
~~~

After the fences ![last](last.png)
