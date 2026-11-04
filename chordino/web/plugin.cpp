// Plugin side: exposes Chordino through the Vamp C API, as its plugin library would.
// Compiled separately from host.cpp: the Vamp plugin and host SDKs can't share a translation unit.

#include <vamp-sdk/PluginAdapter.h>

#include "../nnls-chroma/Chordino.h"

extern "C" const VampPluginDescriptor *chordinoDescriptor()
{
    static Vamp::PluginAdapter<Chordino> adapter;
    return adapter.getDescriptor();
}
