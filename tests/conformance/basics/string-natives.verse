# String helpers from the prelude.
#>> HELLO
#>> world
#>> a-b-c
#>> 2
#>> found
Print(ToUpper("hello"))
Print(ToLower("WORLD"))
Print(Join(array{"a", "b", "c"}, "-"))
Parts := Split("x,y", ",")
Print("{Parts.Length}")
if (Contains["hello world", "lo wo"]):
    Print("found")
