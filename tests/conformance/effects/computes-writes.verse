# A <computes> function cannot declare or write mutable state.
#!! 4: A '<computes>' function cannot declare mutable state
Pure()<computes> : int =
    var Local : int = 0
    Local
