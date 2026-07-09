using { /Fortnite.com/Devices }
using { /Verse.org/Simulation }
using { /UnrealEngine.com/Temporary/Diagnostics }

# Demonstrates Verse failure contexts and transactional rollback.
# A <decides> function fails instead of returning false, and when it fails,
# every write it made is rolled back (like VerseVM's speculative execution).
bank_device := class(creative_device):

    var Vault : []int = array{100}

    # Withdraws from the vault, but fails when it would overdraw.
    # The `set` below is journaled: on failure it is undone.
    Withdraw(Amount : int)<decides> : void =
        if (Balance := Vault[0]):
            set Vault[0] = Balance - Amount
        if (NewBalance := Vault[0]):
            NewBalance >= 0

    OnBegin<override>()<suspends> : void =
        if (Withdraw[30]):
            Print("Withdrew 30 gold")
        if (Withdraw[999]):
            Print("Withdrew 999 gold")
        else:
            Print("Withdrawal of 999 failed - the vault write was rolled back")
        if (Final := Vault[0]):
            Print("Final balance: {Final} gold")
