@file:Suppress("FunctionName", "ClassName", "unused", "EnumEntryName", "UnusedImport")
package com.sourcegraph.cody.protocol_generated;

data class Model(
  val chatDefault: Boolean,
  val editDefault: Boolean,
  val codyProOnly: Boolean,
  val provider: String,
  val title: String,
  val deprecated: Boolean,
)

