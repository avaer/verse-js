# Classes: fields with defaults, methods, archetype construction, var fields.
#>> rex says woof
#>> 3
#>> 4
dog := class:
    Name : string = "dog"
    var Legs : int = 4
    Speak() : string = "{Name} says woof"
D := dog{Name := "rex"}
Print(D.Speak())
if (set D.Legs = 3) {}
Print("{D.Legs}")
E := dog{}
Print("{E.Legs}")
