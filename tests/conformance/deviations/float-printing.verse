# Float-to-string formatting of integral values.
#@@ deviation: Real Verse prints integral floats with a decimal point
#@@ deviation: ("3.0"); JS numbers cannot distinguish 3.0 from 3, so we
#@@ deviation: print "3". Fixing this would require boxing all floats.
#>> 3
#>> 2.5
X : float = 1.5 + 1.5
Print("{X}")
Print("{1.25 * 2.0}")
