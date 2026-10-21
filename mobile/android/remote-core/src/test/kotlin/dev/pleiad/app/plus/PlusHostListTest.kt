package dev.pleiad.app.plus

import dev.pleiad.app.remote.HostRecord
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class PlusHostListTest {
    private fun record(via: String, label: String = "") = HostRecord("h", "PC", label, "https://relay.example", "key", "device", 0, 1, null, null, via,
        if (via == "plus") "u" else null)
    private val listed = PlusHost("h", "key", "PC", "linux", true, null, 1)

    @Test fun combinesOwnOnlyPlusOnlyAndBoth() {
        assertEquals("own", PlusHostList.combine(listOf(record("own")), emptyList(), true).single().via)
        assertEquals("plus", PlusHostList.combine(emptyList(), listOf(listed), true).single().via)
        val both = PlusHostList.combine(listOf(record("own"), record("plus")), listOf(listed), true).single()
        assertEquals("plus", both.via)
        assertEquals(true, both.both)
        assertEquals(true, both.online)
    }

    // ToBe-A (2026-10-21): a host paired both ways stays one row and opens with Plus only while the PC is online on Plus.
    @Test fun aHostPairedBothWaysOpensWithPlusOnlyWhileThePcIsOnlineThere() {
        val both = listOf(record("own"), record("plus"))
        assertEquals("plus", PlusHostList.combine(both, listOf(listed), true).single().via)
        val offline = PlusHostList.combine(both, listOf(listed.copy(online = false)), true)
        assertEquals(1, offline.size)
        assertEquals("own", offline.single().via)
        assertEquals("own", PlusHostList.combine(both, emptyList(), true).single().via)
        // A window connected on one route keeps it, whatever the ledger says now.
        assertEquals("own", PlusHostList.combine(both, listOf(listed), true, mapOf("h" to "own")).single().via)
        assertEquals("plus", PlusHostList.combine(both, listOf(listed.copy(online = false)), true, mapOf("h" to "plus")).single().via)
    }

    @Test fun failedListCanUseLastKnownPlusRowsAndUnavailableAccountHidesThem() {
        assertEquals(1, PlusHostList.combine(listOf(record("plus")), listOf(listed), true).size)
        assertEquals(0, PlusHostList.combine(listOf(record("plus")), listOf(listed), false).size)
        val own = PlusHostList.combine(listOf(record("own"), record("plus")), listOf(listed), false).single()
        assertEquals("own", own.via)
        assertNull(own.plus)
    }
}
