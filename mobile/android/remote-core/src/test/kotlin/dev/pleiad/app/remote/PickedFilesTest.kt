package dev.pleiad.app.remote

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class PickedFilesTest {
    @Test fun cancelIsNull() {
        assertNull(PickedFiles.of(ok = false, clip = listOf("a", "b"), single = "a"))
        assertNull(PickedFiles.of(ok = false, clip = emptyList<String>(), single = null))
    }

    @Test fun multiplePicksComeFromTheClip() {
        assertEquals(listOf("a", "b", "c"), PickedFiles.of(ok = true, clip = listOf("a", "b", "c"), single = null))
        // A single pick may also arrive as a one-item ClipData
        assertEquals(listOf("a"), PickedFiles.of(ok = true, clip = listOf("a"), single = null))
    }

    @Test fun aSinglePickMayBeInGetData() {
        assertEquals(listOf("b"), PickedFiles.of(ok = true, clip = emptyList(), single = "b"))
    }

    @Test fun nullClipItemsAreDroppedAndTheRestWinsOverGetData() {
        assertEquals(listOf("a", "c"), PickedFiles.of(ok = true, clip = listOf("a", null, "c"), single = "b"))
        assertEquals(listOf("a"), PickedFiles.of(ok = true, clip = listOf("a"), single = "b"))
    }

    @Test fun anEmptyClipFallsBackToGetData() {
        assertEquals(listOf("b"), PickedFiles.of(ok = true, clip = listOf<String?>(null), single = "b"))
        assertEquals(listOf("b"), PickedFiles.of(ok = true, clip = listOf(null, null), single = "b"))
    }

    @Test fun nothingPickedIsNull() {
        assertNull(PickedFiles.of(ok = true, clip = emptyList<String>(), single = null))
        assertNull(PickedFiles.of(ok = true, clip = listOf<String?>(null), single = null))
    }
}
