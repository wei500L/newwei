package analysiscollab

import "testing"

func TestNormalizeQueryStringKeepsOrderAndDuplicates(t *testing.T) {
	got := NormalizeQueryString("  ??savedView=1&q=a&page=2&q=b%20c&pageSize=10&topic=x")
	want := "q=a&q=b+c&topic=x"
	if got != want {
		t.Fatalf("got %q want %q", got, want)
	}
}

func TestValidColumnOrderRejectsDuplicates(t *testing.T) {
	existing := []string{"a", "b", "c", "d"}
	if ValidColumnOrder([]string{"a", "a", "b", "c"}, existing) {
		t.Fatal("duplicate ids were accepted")
	}
	if ValidColumnOrder([]string{"a", "b", "c"}, existing) {
		t.Fatal("missing id was accepted")
	}
	if !ValidColumnOrder([]string{"d", "c", "b", "a"}, existing) {
		t.Fatal("permutation was rejected")
	}
}

func TestPlanTaskMoveSameColumnDownward(t *testing.T) {
	got := PlanTaskMove("B", []string{"A", "B", "C", "D"}, true, 3)
	want := []string{"A", "C", "B", "D"}
	if len(got) != len(want) {
		t.Fatalf("got %v", got)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("got %v want %v", got, want)
		}
	}
}

func TestValidateBodyKeepsNullDistinctFromMissing(t *testing.T) {
	body, err := ValidateBody([]byte(`{"description":null,"title":"  Watch  "}`), UpdateViewSpecs())
	if err != nil {
		t.Fatal(err)
	}
	if body.Has("routePath") {
		t.Fatal("missing routePath looked present")
	}
	if !body.Has("description") || !body.Null("description") {
		t.Fatal("explicit null description was not preserved")
	}
	if body.String("title") != "  Watch  " {
		t.Fatalf("title = %q", body.String("title"))
	}
}

func TestValidateBodyRejectsUnknownField(t *testing.T) {
	_, err := ValidateBody([]byte(`{"title":"x","surface":"search","routePath":"/search","extra":1}`), CreateViewSpecs())
	if err == nil || err.Error() != "property extra should not exist" {
		t.Fatalf("err = %v", err)
	}
}
