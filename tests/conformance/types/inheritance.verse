# Inheritance, <override>, super dispatch, and abstract-style base methods.
#>> generic sound
#>> meow
#>> meow then generic sound
animal := class:
    Sound() : string = "generic sound"
cat := class(animal):
    Sound<override>() : string = "meow"
    Both() : string = "{Sound()} then {(super:)Sound()}"
A := animal{}
C := cat{}
Print(A.Sound())
Print(C.Sound())
Print(C.Both())
