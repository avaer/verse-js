# Multi-file workspaces: this file calls functions defined in
# math-lib.verse. Press Run with this file active — it becomes the entry
# point and the rest of the workspace acts as a library. Try Ctrl+Click
# on the call below to jump to the defining file.

Avg := Average(3.0, 5.0)
Mid := Lerp(0.0, 10.0, 0.25)

Print("Average(3.0, 5.0) = {Avg}")
Print("Lerp(0.0, 10.0, 0.25) = {Mid}")
Print("GoldenRatio = {GoldenRatio}")
