# Integer width.
#@@ deviation: Real Verse ints are arbitrary precision (BigInt-like).
#@@ deviation: We use JS numbers, exact only up to 2^53 - 1. Values beyond
#@@ deviation: that lose precision silently.
#>> 9007199254740991
#>> 9007199254740992
Print("{9007199254740991}")
Print("{9007199254740991 + 1}")
