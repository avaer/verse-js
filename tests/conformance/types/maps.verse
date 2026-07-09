# Maps: literals, failable lookup, insertion via set, iteration, tuple keys.
#>> 10
#>> missing
#>> 2
#>> a=1 b=2
M : [string]int = map{"a" => 10}
if (V := M["a"]):
    Print("{V}")
if (M["zzz"]):
    Print("not printed")
else:
    Print("missing")
var W : [string]int = map{"a" => 1, "b" => 2}
Print("{W.Length}")
var Text : string = ""
for (Key -> Value : W):
    set Text += "{Key}={Value} "
Print(if (T := Text.Slice[0, 7]) then T else Text)
