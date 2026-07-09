# The three block forms: indentation, braces, and semicolons.
#>> indent
#>> brace
#>> semi
A() : void =
    Print("indent")
B() : void = { Print("brace") }
C() : void = Print("semi")
A()
B()
C()
