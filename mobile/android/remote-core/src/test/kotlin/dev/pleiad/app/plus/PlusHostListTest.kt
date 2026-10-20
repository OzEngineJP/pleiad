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
        assertEquals("both", both.via)
        assertEquals(true, both.online)
    }

    @Test fun failedListCanUseLastKnownPlusRowsAndUnavailableAccountHidesThem() {
        assertEquals(1, PlusHostList.combine(listOf(record("plus")), listOf(listed), true).size)
        assertEquals(0, PlusHostList.combine(listOf(record("plus")), listOf(listed), false).size)
        val own = PlusHostList.combine(listOf(record("own"), record("plus")), listOf(listed), false).single()
        assertEquals("own", own.via)
        assertNull(own.plus)
    }
}
