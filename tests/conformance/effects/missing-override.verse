# Redefining an inherited method requires the <override> specifier.
#!! 6: must be marked <override>
base := class:
    Greet() : string = "hi"
derived := class(base):
    Greet() : string = "hello"
