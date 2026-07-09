# unique classes compare by identity; castable enables downcasts.
#>> same
#>> not equal
#>> got cat
token := class<unique>:
    Label : string = ""
A := token{Label := "x"}
B := token{Label := "x"}
if (A = A):
    Print("same")
if (A = B):
    Print("equal (wrong)")
else:
    Print("not equal")
animal := class:
    Name : string = ""
cat := class(animal):
    Lives : int = 9
Pet : animal = cat{}
if (cat[Pet]):
    Print("got cat")
