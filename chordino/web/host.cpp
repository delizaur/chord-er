// Host side: runs Chordino on a mono signal the way Vamp hosts (Sonic Visualiser, sonic-annotator)
// do. PluginHostAdapter wraps the plugin's C descriptor, and PluginInputDomainAdapter supplies the
// windowed FFT frames Chordino expects. Default parameters, preferred block and step sizes.

#include <vamp-hostsdk/PluginHostAdapter.h>
#include <vamp-hostsdk/PluginInputDomainAdapter.h>

#include <cstdio>
#include <cstring>
#include <string>
#include <vector>

using Vamp::Plugin;
using Vamp::RealTime;
using Vamp::HostExt::PluginInputDomainAdapter;

extern "C" const VampPluginDescriptor *chordinoDescriptor();

static std::string result;

// Returns the "simplechord" output as lines of "<seconds>\t<label>", or a line starting with
// "error" when the plugin can't run.
extern "C" const char *chordino_run(const float *samples, int length, float sampleRate)
{
    result.clear();
    Plugin *plugin = new PluginInputDomainAdapter(new Vamp::PluginHostAdapter(chordinoDescriptor(), sampleRate));
    const size_t block = plugin->getPreferredBlockSize();
    const size_t step = plugin->getPreferredStepSize();
    if (!plugin->initialise(1, step, block)) {
        delete plugin;
        result = "error: initialise failed";
        return result.c_str();
    }

    int output = -1;
    Plugin::OutputList outputs = plugin->getOutputDescriptors();
    for (size_t i = 0; i < outputs.size(); ++i) {
        if (outputs[i].identifier == "simplechord") output = int(i);
    }

    auto collect = [&](Plugin::FeatureSet &features) {
        for (const Plugin::Feature &f : features[output]) {
            char time[32];
            snprintf(time, sizeof time, "%.6f", f.timestamp.sec + f.timestamp.nsec / 1e9);
            result += time;
            result += '\t';
            result += f.label;
            result += '\n';
        }
    };

    // Blocks start every `step` samples; the last ones are zero-padded.
    std::vector<float> buffer(block);
    for (size_t start = 0; start < size_t(length); start += step) {
        const size_t count = std::min(block, size_t(length) - start);
        std::memcpy(buffer.data(), samples + start, count * sizeof(float));
        std::fill(buffer.begin() + count, buffer.end(), 0.f);
        const float *channels[1] = {buffer.data()};
        Plugin::FeatureSet features = plugin->process(channels, RealTime::frame2RealTime(long(start), (unsigned int)(sampleRate)));
        collect(features);
    }
    Plugin::FeatureSet rest = plugin->getRemainingFeatures();
    collect(rest);
    delete plugin;
    return result.c_str();
}
