# Named (?X) parameters with defaults, passed as ?X := value.
#>> 10
#>> 25
Scale(X : int, ?Factor : int = 2) : int = X * Factor
Print("{Scale(5)}")
Print("{Scale(5, ?Factor := 5)}")
