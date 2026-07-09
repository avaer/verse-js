# if as an expression: then/else form and value production.
#>> big
#>> 10
#>> 1
X := 100
Print(if (X > 50) then "big" else "small")
Y := if (X > 50) then 10 else 20
Print("{Y}")
# Failable binding in the condition scopes into then.
Z := if (V := X / 100) then V else 0
Print("{Z}")
