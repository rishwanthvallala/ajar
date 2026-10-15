void main() {
    IO.println("compact source file says hi");
    var xs = java.util.List.of(3, 1, 2);
    IO.println(xs.stream().sorted().toList());
    IO.print("no newline");
    IO.println();
}
