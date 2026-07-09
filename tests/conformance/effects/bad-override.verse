# <override> with no inherited member to override is an error.
#!! 6: no base class or interface declares it
base := class:
    Greet() : string = "hi"
derived := class(base):
    Shout<override>() : string = "HELLO"
