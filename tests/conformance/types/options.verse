# Option types: option{}, false as empty, postfix ? query, and re-setting.
#>> verse
#>> empty
#>> 7
#>> filled: 9
MaybeName : ?string = option{"verse"}
if (N := MaybeName?):
    Print(N)
Empty : ?int = false
if (Empty?):
    Print("not printed")
else:
    Print("empty")
Val : ?int = option{7}
if (V := Val?):
    Print("{V}")
var Slot : ?int = false
set Slot = option{9}
if (S := Slot?):
    Print("filled: {S}")
