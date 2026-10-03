const { createApp } = Vue;

createApp({
  data() {
    return {
      trips: [],
      stats: {
        total: 0,
        pending: 0,
        running: 0,
        completed: 0
      },
      loading: false,
      parsing: false,
      saving: false,
      rawInput: "",
      preview: null,
      searchTerm: "",
      statusFilter: "all",
      searchTimeout: null,

      sampleMessages: [
        "I want to travel from Chennai to some hill station on 24 Dec 2026 with my wife - can you suggest some ideas",
        "This weekend me and my family of 3 members want to visit some resort around Kochin - can you suggest",
        "Looking for a 4-day trip from Bangalore to Goa next month for 4 friends, budget 40000 INR",
        "Solo backpacking from Delhi to Manali on 15 Nov 2026, budget $300"
      ],

      // Chat modal state
      showChatModal: false,
      activeChatTrip: null,
      chats: [],
      chatInput: "",
      chatSending: false,

      // Timeline & Pipeline state
      showTimelineModal: false,
      activeTimelineTrip: null,
      timelineEvents: [],
      timelineRunState: null,
      pipelineRunningId: null,

      // Modal state
      showModal: false,
      editingTrip: null,
      form: {
        id: null,
        raw_message: "",
        origin: "",
        destination: "",
        start_date: "",
        end_date: "",
        travelers: 1,
        budget_usd: 500,
        trip_type: "hill station",
        companions: "",
        preferences: "",
        status: "pending"
      }
    };
  },
  mounted() {
    this.fetchTrips();
    this.fetchStats();
  },
  methods: {
    async fetchTrips() {
      this.loading = true;
      try {
        const params = new URLSearchParams();
        if (this.statusFilter !== "all") params.append("status", this.statusFilter);
        if (this.searchTerm.trim()) params.append("search", this.searchTerm.trim());

        const res = await fetch(`/api/trips?${params.toString()}`);
        const data = await res.json();
        if (data.success) {
          this.trips = data.trips;
        }
      } catch (err) {
        console.error("Error fetching trips:", err);
      } finally {
        this.loading = false;
        this.fetchStats();
      }
    },

    async fetchStats() {
      try {
        const res = await fetch("/api/stats");
        const data = await res.json();
        if (data.success) {
          this.stats = data.stats;
        }
      } catch (err) {
        console.error("Error fetching stats:", err);
      }
    },

    useSample(text) {
      this.rawInput = text;
      this.testExtract();
    },

    async testExtract() {
      if (!this.rawInput.trim()) return;
      this.parsing = true;
      try {
        const res = await fetch("/api/extract", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text: this.rawInput })
        });
        const data = await res.json();
        if (data.success) {
          this.preview = data.extracted;
        }
      } catch (err) {
        console.error("Extraction error:", err);
      } finally {
        this.parsing = false;
      }
    },

    async saveExtracted() {
      if (!this.rawInput.trim()) return;
      this.parsing = true;
      try {
        const res = await fetch("/api/trips", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ raw_message: this.rawInput })
        });
        const data = await res.json();
        if (data.success) {
          this.rawInput = "";
          this.preview = null;
          await this.fetchTrips();
        } else {
          alert("Error saving: " + data.error);
        }
      } catch (err) {
        console.error("Save error:", err);
      } finally {
        this.parsing = false;
      }
    },

    filterDebounce() {
      clearTimeout(this.searchTimeout);
      this.searchTimeout = setTimeout(() => {
        this.fetchTrips();
      }, 300);
    },

    openNewModal() {
      this.editingTrip = null;
      this.form = {
        id: null,
        raw_message: "",
        origin: "",
        destination: "",
        start_date: new Date().toISOString().split("T")[0],
        end_date: "",
        travelers: 1,
        budget_usd: 500,
        trip_type: "hill station",
        companions: "",
        preferences: "",
        status: "pending"
      };
      this.showModal = true;
    },

    openEditModal(trip) {
      this.editingTrip = trip;
      this.form = { ...trip };
      this.showModal = true;
    },

    closeModal() {
      this.showModal = false;
      this.editingTrip = null;
    },

    async autoFillFromFormMessage() {
      if (!this.form.raw_message.trim()) return;
      try {
        const res = await fetch("/api/extract", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text: this.form.raw_message })
        });
        const data = await res.json();
        if (data.success) {
          const ext = data.extracted;
          if (!this.form.origin) this.form.origin = ext.origin;
          if (!this.form.destination) this.form.destination = ext.destination;
          if (!this.form.start_date || this.form.start_date === new Date().toISOString().split("T")[0]) {
            this.form.start_date = ext.start_date;
          }
          if (!this.form.end_date) this.form.end_date = ext.end_date;
          if (ext.travelers) this.form.travelers = ext.travelers;
          if (ext.companions) this.form.companions = ext.companions;
          if (ext.trip_type) this.form.trip_type = ext.trip_type;
          if (ext.budget_usd) this.form.budget_usd = ext.budget_usd;
        }
      } catch (e) {
        console.error("Auto fill error", e);
      }
    },

    async saveTripForm() {
      this.saving = true;
      try {
        const isEdit = !!this.editingTrip;
        const url = isEdit ? `/api/trips/${this.form.id}` : "/api/trips";
        const method = isEdit ? "PUT" : "POST";

        const res = await fetch(url, {
          method,
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(this.form)
        });

        const data = await res.json();
        if (data.success) {
          this.closeModal();
          await this.fetchTrips();
        } else {
          alert("Error: " + data.error);
        }
      } catch (err) {
        console.error("Error saving trip:", err);
      } finally {
        this.saving = false;
      }
    },

    async deleteTrip(id) {
      if (!confirm(`Delete trip record #${id}?`)) return;
      try {
        const res = await fetch(`/api/trips/${id}`, { method: "DELETE" });
        const data = await res.json();
        if (data.success) {
          await this.fetchTrips();
        }
      } catch (err) {
        console.error("Delete error:", err);
      }
    },

    async openChatModal(trip) {
      this.activeChatTrip = trip;
      this.showChatModal = true;
      this.chats = [];
      this.chatInput = "";
      await this.fetchChats(trip.id);
    },

    closeChatModal() {
      this.showChatModal = false;
      this.activeChatTrip = null;
      this.chats = [];
    },

    async fetchChats(tripId) {
      try {
        const res = await fetch(`/api/trips/${tripId}/chats`);
        const data = await res.json();
        if (data.success) {
          this.chats = data.chats;
          this.scrollChat();
        }
      } catch (e) {
        console.error("Error fetching chats:", e);
      }
    },

    async sendChatMessage() {
      if (!this.chatInput.trim() || this.chatSending || !this.activeChatTrip) return;
      const msg = this.chatInput.trim();
      this.chatInput = "";
      this.chatSending = true;

      // Optimistic user bubble
      this.chats.push({ id: Date.now(), sender: "user", message: msg });
      this.scrollChat();

      try {
        const res = await fetch(`/api/trips/${this.activeChatTrip.id}/chats`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ message: msg })
        });
        const data = await res.json();
        if (data.success) {
          this.chats = data.chats;
          this.scrollChat();
        } else {
          alert("Chat error: " + data.error);
        }
      } catch (err) {
        console.error("Chat error:", err);
      } finally {
        this.chatSending = false;
      }
    },

    scrollChat() {
      this.$nextTick(() => {
        const el = this.$refs.chatBody;
        if (el) el.scrollTop = el.scrollHeight;
      });
    },

    async runPipeline(trip) {
      if (!trip) return;
      this.pipelineRunningId = trip.id;
      try {
        const res = await fetch(`/api/trips/${trip.id}/run`, { method: "POST" });
        const data = await res.json();
        if (data.success) {
          await this.fetchTrips();
          if (this.showTimelineModal && this.activeTimelineTrip?.id === trip.id) {
            await this.fetchTimeline(trip.id);
          }
        } else {
          alert("Pipeline error: " + data.error);
        }
      } catch (e) {
        console.error("Run error:", e);
      } finally {
        this.pipelineRunningId = null;
      }
    },

    async openTimelineModal(trip) {
      this.activeTimelineTrip = trip;
      this.showTimelineModal = true;
      this.timelineEvents = [];
      this.timelineRunState = null;
      await this.fetchTimeline(trip.id);
    },

    closeTimelineModal() {
      this.showTimelineModal = false;
      this.activeTimelineTrip = null;
      this.timelineEvents = [];
    },

    async fetchTimeline(tripId) {
      try {
        const res = await fetch(`/api/trips/${tripId}/events`);
        const data = await res.json();
        if (data.success) {
          this.timelineEvents = data.events;
          this.timelineRunState = data.run_state;
          if (data.trip) this.activeTimelineTrip = data.trip;
        }
      } catch (e) {
        console.error("Error fetching timeline:", e);
      }
    },

    formatJson(jsonStr) {
      if (!jsonStr) return "";
      try {
        const obj = typeof jsonStr === "string" ? JSON.parse(jsonStr) : jsonStr;
        return JSON.stringify(obj, null, 2);
      } catch {
        return jsonStr;
      }
    },

    getFinalItineraryText(finalResult) {
      if (!finalResult) return "";
      try {
        const parsed = typeof finalResult === "string" ? JSON.parse(finalResult) : finalResult;
        if (parsed.custom_plan) {
          return `${parsed.route} (${parsed.duration})\nBudget: ${parsed.total_budget}\n\n${parsed.custom_plan}`;
        }
        if (parsed.reason) {
          return `Reason for rejection: ${parsed.reason}\n${parsed.suggested_action || ''}`;
        }
        return JSON.stringify(parsed, null, 2);
      } catch {
        return finalResult;
      }
    },

    formatDate(dateStr) {
      if (!dateStr) return "";
      try {
        const d = new Date(dateStr);
        return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
      } catch {
        return dateStr;
      }
    }
  }
}).mount("#app");
