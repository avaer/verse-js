# Type aliases via type{...}.
#>> 100
#>> alias ok
score := type{int}
Points : score = 100
Print("{Points}")
name_list := type{[]string}
Names : name_list = array{"a", "b"}
if (Names.Length = 2):
    Print("alias ok")
